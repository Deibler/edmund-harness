// FaceTimeControl — injected into FaceTime.app.
//
// Owns call control through TelephonyUtilities (private): it reports every call
// FaceTime sees and dials, answers and hangs up when told to. It decides
// nothing. Who may be called, which session a call belongs to and whether the
// connected party is the one that was dialled are all the daemon's questions;
// this file only answers "what is happening" and "do this".
//
// Wire protocol: newline-delimited JSON over a Unix stream socket the daemon
// listens on ($EDMUND_FACETIME_SOCKET). The dylib dials out and keeps
// redialling, so a daemon restart never needs FaceTime relaunched.
//
//   request  {"id":"1","method":"dial","params":{"handle":"+15550100"}}
//   response {"id":"1","ok":true,"result":{...}} | {"id":"1","ok":false,"error":"..."}
//   event    {"event":"call","call":{...}}
//
// Loaded the same way imcore-bridge loads into Messages: DYLD_INSERT_LIBRARIES
// with SIP off and amfi_get_out_of_my_way=0x1. FaceTime is a Mac Catalyst app,
// like Messages, and a plain arm64e macOS dylib loads into both.

#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <sys/socket.h>
#import <sys/un.h>
#import <unistd.h>

// The TelephonyUtilities shapes this file uses, as protocols so each receiver
// is typed (an untyped `id` makes -status ambiguous with Foundation's). The
// encodings were read from the 26.4 runtime before writing these.
@protocol EdmundHandle <NSObject>
- (NSString *)value;
@end

@protocol EdmundProvider <NSObject>
- (NSString *)identifier;
- (BOOL)isFaceTimeProvider;
@end

@protocol EdmundCall <NSObject>
- (NSString *)uniqueProxyIdentifier;
- (int)status;
- (int)disconnectedReason;
- (BOOL)isIncoming;
- (BOOL)isVideo;
- (BOOL)isConversation;
- (id<EdmundHandle>)handle;
- (NSSet<id<EdmundHandle>> *)remoteParticipantHandles;
- (id<EdmundProvider>)provider;
@end

@protocol EdmundConversation <NSObject>
- (NSUUID *)messagesGroupUUID;
- (NSUUID *)groupUUID;
@end

@protocol EdmundProviderManager <NSObject>
- (id<EdmundProvider>)faceTimeProvider;
@end

@protocol EdmundCallCenter <NSObject>
- (NSArray<id<EdmundCall>> *)currentCalls;
- (void)dialWithRequest:(id)request completion:(void (^)(id<EdmundCall> call))completion;
- (void)answerCall:(id<EdmundCall>)call;
- (void)disconnectCall:(id<EdmundCall>)call;
- (id<EdmundConversation>)activeConversationForCall:(id<EdmundCall>)call;
- (id<EdmundProviderManager>)providerManager;
@end

@protocol EdmundDialRequest <NSObject>
- (instancetype)initWithProvider:(id<EdmundProvider>)provider;
- (void)setHandle:(id<EdmundHandle>)handle;
- (void)setVideo:(BOOL)video;
- (void)setShowUIPrompt:(BOOL)show;
- (BOOL)isValid;
@end

@interface NSObject (EdmundTelephonyClass)
+ (id)sharedInstance;
+ (id)handleWithDestinationID:(NSString *)destination;
@end

static NSString *const kLogPrefix = @"[edmund-facetime]";
static int gSocket = -1;
static dispatch_queue_t gWriteQueue;
static id<EdmundCallCenter> gCenter;

#pragma mark - Wire

static void sendObject(NSDictionary *object) {
  NSError *error = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
  if (!json) {
    NSLog(@"%@ unserialisable message: %@", kLogPrefix, error);
    return;
  }
  NSMutableData *line = [json mutableCopy];
  [line appendBytes:"\n" length:1];
  dispatch_async(gWriteQueue, ^{
    if (gSocket < 0) return;
    const uint8_t *bytes = line.bytes;
    size_t left = line.length;
    while (left > 0) {
      ssize_t n = write(gSocket, bytes, left);
      if (n <= 0) return;  // The reader notices the dead socket and redials.
      bytes += n;
      left -= (size_t)n;
    }
  });
}

static void reply(NSString *requestId, id result, NSString *error) {
  if (!requestId) return;
  if (error) {
    sendObject(@{@"id" : requestId, @"ok" : @NO, @"error" : error});
  } else {
    sendObject(@{@"id" : requestId, @"ok" : @YES, @"result" : result ?: [NSNull null]});
  }
}

#pragma mark - Calls

/// TUCallStatus names, as far as they are known. The raw value is always sent
/// too: the daemon must not trust a name this file guessed.
static NSString *stateName(int status) {
  switch (status) {
    case 1: return @"active";
    case 2: return @"held";
    case 3: return @"sending";
    case 4: return @"ringing";
    case 5: return @"disconnecting";
    case 6: return @"disconnected";
    default: return [NSString stringWithFormat:@"unknown-%d", status];
  }
}

static id orNull(id value) { return value ?: [NSNull null]; }

static NSDictionary *describeCall(id<EdmundCall> call) {
  NSMutableArray *remotes = [NSMutableArray array];
  for (id<EdmundHandle> handle in [call remoteParticipantHandles] ?: [NSSet set]) {
    NSString *value = [handle value];
    if (value) [remotes addObject:value];
  }
  id<EdmundConversation> conversation = nil;
  if ([gCenter respondsToSelector:@selector(activeConversationForCall:)]) {
    conversation = [gCenter activeConversationForCall:call];
  }
  id<EdmundProvider> provider = [call provider];
  return @{
    @"id" : orNull([call uniqueProxyIdentifier]),
    @"status" : @([call status]),
    @"state" : stateName([call status]),
    @"incoming" : @([call isIncoming]),
    @"video" : @([call isVideo]),
    @"conversation" : @([call isConversation]),
    @"handle" : orNull([[call handle] value]),
    @"remoteHandles" : remotes,
    @"messagesGroupUUID" : orNull([[conversation messagesGroupUUID] UUIDString]),
    @"groupUUID" : orNull([[conversation groupUUID] UUIDString]),
    @"provider" : orNull([provider identifier]),
    @"faceTime" : @([provider isFaceTimeProvider]),
    @"disconnectedReason" : @([call disconnectedReason]),
  };
}

static id<EdmundCall> findCall(NSString *callId) {
  for (id<EdmundCall> call in [gCenter currentCalls] ?: @[]) {
    if ([[call uniqueProxyIdentifier] isEqualToString:callId]) return call;
  }
  return nil;
}

static void onCallStatusChanged(NSNotification *note) {
  id<EdmundCall> call = note.object;
  if (!call) return;
  sendObject(@{@"event" : @"call", @"call" : describeCall(call)});
}

#pragma mark - Methods

static void handleStatus(NSString *requestId) {
  NSMutableArray *calls = [NSMutableArray array];
  for (id<EdmundCall> call in [gCenter currentCalls] ?: @[]) [calls addObject:describeCall(call)];
  id<EdmundProvider> provider = [[gCenter providerManager] faceTimeProvider];
  reply(requestId, @{@"calls" : calls, @"faceTimeProvider" : @(provider != nil)}, nil);
}

static void handleDial(NSString *requestId, NSDictionary *params) {
  NSString *destination = params[@"handle"];
  if (![destination isKindOfClass:[NSString class]] || destination.length == 0) {
    reply(requestId, nil, @"dial needs a handle");
    return;
  }
  id<EdmundProvider> provider = [[gCenter providerManager] faceTimeProvider];
  if (!provider) {
    reply(requestId, nil, @"no FaceTime provider (is FaceTime signed in?)");
    return;
  }
  id<EdmundDialRequest> request = [(id<EdmundDialRequest>)[NSClassFromString(@"TUDialRequest") alloc] initWithProvider:provider];
  [request setHandle:[NSClassFromString(@"TUHandle") handleWithDestinationID:destination]];
  [request setVideo:[params[@"video"] boolValue]];
  [request setShowUIPrompt:NO];
  if (![request isValid]) {
    reply(requestId, nil, @"dial request is not valid for this handle");
    return;
  }
  [gCenter dialWithRequest:request
                completion:^(id<EdmundCall> call) {
                  dispatch_async(dispatch_get_main_queue(), ^{
                    if (call) {
                      reply(requestId, describeCall(call), nil);
                    } else {
                      reply(requestId, nil, @"FaceTime returned no call");
                    }
                  });
                }];
}

static void handleCallCommand(NSString *requestId, NSString *method, NSDictionary *params) {
  NSString *callId = params[@"id"];
  id<EdmundCall> call = [callId isKindOfClass:[NSString class]] ? findCall(callId) : nil;
  if (!call) {
    reply(requestId, nil, [NSString stringWithFormat:@"no current call with id %@", callId]);
    return;
  }
  if ([method isEqualToString:@"answer"]) {
    [gCenter answerCall:call];
  } else {
    [gCenter disconnectCall:call];
  }
  // An acknowledgement means the request was made, not that it took effect:
  // the call event that follows is the outcome.
  reply(requestId, describeCall(call), nil);
}

static void handleLine(NSData *line) {
  NSDictionary *message = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
  if (![message isKindOfClass:[NSDictionary class]]) return;
  NSString *requestId = message[@"id"];
  NSString *method = message[@"method"];
  NSDictionary *params = [message[@"params"] isKindOfClass:[NSDictionary class]] ? message[@"params"] : @{};
  dispatch_async(dispatch_get_main_queue(), ^{
    @try {
      if ([method isEqualToString:@"ping"]) {
        reply(requestId, @"pong", nil);
      } else if ([method isEqualToString:@"status"]) {
        handleStatus(requestId);
      } else if ([method isEqualToString:@"dial"]) {
        handleDial(requestId, params);
      } else if ([method isEqualToString:@"answer"] || [method isEqualToString:@"hangup"]) {
        handleCallCommand(requestId, method, params);
      } else {
        reply(requestId, nil, [NSString stringWithFormat:@"unknown method %@", method]);
      }
    } @catch (NSException *exception) {
      reply(requestId, nil, [NSString stringWithFormat:@"%@: %@", exception.name, exception.reason]);
    }
  });
}

#pragma mark - Connection

static int dialDaemon(NSString *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_un addr = {0};
  addr.sun_family = AF_UNIX;
  strlcpy(addr.sun_path, path.fileSystemRepresentation, sizeof(addr.sun_path));
  if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

static void readLoop(NSString *path) {
  useconds_t backoff = 500000;
  for (;;) {
    int fd = dialDaemon(path);
    if (fd < 0) {
      usleep(backoff);
      backoff = MIN(backoff * 2, 5000000);
      continue;
    }
    backoff = 500000;
    dispatch_sync(gWriteQueue, ^{ gSocket = fd; });
    sendObject(@{@"event" : @"hello", @"pid" : @(getpid())});
    NSLog(@"%@ connected to %@", kLogPrefix, path);

    NSMutableData *buffer = [NSMutableData data];
    uint8_t chunk[4096];
    for (;;) {
      ssize_t n = read(fd, chunk, sizeof(chunk));
      if (n <= 0) break;
      [buffer appendBytes:chunk length:(NSUInteger)n];
      for (;;) {
        NSRange newline = [buffer rangeOfData:[NSData dataWithBytes:"\n" length:1]
                                      options:0
                                        range:NSMakeRange(0, buffer.length)];
        if (newline.location == NSNotFound) break;
        handleLine([buffer subdataWithRange:NSMakeRange(0, newline.location)]);
        [buffer replaceBytesInRange:NSMakeRange(0, newline.location + 1) withBytes:NULL length:0];
      }
    }
    dispatch_sync(gWriteQueue, ^{ gSocket = -1; });
    close(fd);
    NSLog(@"%@ daemon connection closed; redialling", kLogPrefix);
  }
}

#pragma mark - Load

__attribute__((constructor)) static void edmundFaceTimeControlLoad(void) {
  NSString *path = NSProcessInfo.processInfo.environment[@"EDMUND_FACETIME_SOCKET"];
  if (path.length == 0) return;  // Loaded without a daemon to talk to: stay inert.
  gWriteQueue = dispatch_queue_create("edmund.facetime.write", DISPATCH_QUEUE_SERIAL);

  dispatch_async(dispatch_get_main_queue(), ^{
    if (!dlopen("/System/Library/PrivateFrameworks/TelephonyUtilities.framework/TelephonyUtilities", RTLD_NOW)) {
      NSLog(@"%@ TelephonyUtilities did not load: %s", kLogPrefix, dlerror());
      return;
    }
    gCenter = [NSClassFromString(@"TUCallCenter") sharedInstance];
    NSString *__unsafe_unretained const *statusChanged =
        (NSString *__unsafe_unretained const *)dlsym(RTLD_DEFAULT, "TUCallCenterCallStatusChangedNotification");
    if (!gCenter || !statusChanged) {
      NSLog(@"%@ TUCallCenter unavailable (center=%@)", kLogPrefix, gCenter);
      return;
    }
    [NSNotificationCenter.defaultCenter addObserverForName:*statusChanged
                                                    object:nil
                                                     queue:NSOperationQueue.mainQueue
                                                usingBlock:^(NSNotification *note) {
                                                  onCallStatusChanged(note);
                                                }];
    [NSThread detachNewThreadWithBlock:^{ readLoop(path); }];
  });
}
