import AVFAudio
import CoreMedia
import Foundation
import Speech

/// On-device speech recognition of the call audio, through Apple's
/// SpeechAnalyzer (macOS 26): a transcriber with volatile (in-progress)
/// results, and a speech detector for when the caller starts and stops.
///
/// Times are milliseconds from the start of this listening session. The audio
/// is fed continuously, silence included, so that clock stays aligned with
/// wall time and the daemon can map it back with one offset.
final class Hearing {
  private var analyzer: SpeechAnalyzer?
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var tasks: [Task<Void, Never>] = []
  private let emit: (String, [String: Any]) -> Void
  private(set) var format: AVAudioFormat?
  /// The caller's last 10 s, for the turn detector, on the analyzer's clock.
  private let recent = RecentAudio(seconds: 10)

  /// True between start() and stop(). Not `format != nil`: the format outlives
  /// a stopped analyzer, and listening for a second call on that test fed
  /// every buffer to an analyzer that no longer existed (2026-10-29: the
  /// first call after launch heard the caller, the next heard nothing).
  var isRunning: Bool { analyzer != nil }

  init(emit: @escaping (String, [String: Any]) -> Void) {
    self.emit = emit
  }

  /// Prepares the models and returns the audio format to feed.
  func start(locale: Locale) async throws -> AVAudioFormat {
    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [.volatileResults, .fastResults],
      attributeOptions: [.audioTimeRange]
    )
    let detector = SpeechDetector(detectionOptions: .init(sensitivityLevel: .medium), reportResults: true)
    let modules: [any SpeechModule] = [transcriber, detector]

    if let install = try await AssetInventory.assetInstallationRequest(supporting: modules) {
      try await install.downloadAndInstall()
    }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) else {
      throw NSError(domain: "Hearing", code: 1, userInfo: [NSLocalizedDescriptionKey: "no audio format for speech"])
    }

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    let analyzer = SpeechAnalyzer(modules: modules)
    try await analyzer.start(inputSequence: stream)
    self.analyzer = analyzer
    self.input = continuation
    self.format = format

    let emit = self.emit
    let recent = self.recent
    recent.reset()
    // The caller just paused: hand the turn detector their last 8 s, ending a
    // moment after the speech did. Whether the pause ends their turn, and so
    // whether to finalize (below), is the daemon's call.
    recent.onPause = { stopMs in
      emit("pause", [
        "stopMs": stopMs,
        "originMs": recent.originMs ?? NSNull(),
        "pcm": recent.clip(endingAtMs: stopMs + 200, seconds: 8) ?? NSNull(),
      ])
    }
    // Talking again: whatever was decided about the last pause no longer holds.
    recent.onSpeechStart = { startMs in
      emit("speech", [
        "detected": true,
        "source": "activity",
        "startMs": startMs,
        "endMs": startMs,
        "originMs": recent.originMs ?? NSNull(),
      ])
    }
    tasks.append(Task {
      do {
        for try await result in transcriber.results {
          emit("transcript", [
            "text": String(result.text.characters),
            "final": result.isFinal,
            "startMs": Self.ms(result.range.start),
            "endMs": Self.ms(result.range.end),
            "originMs": recent.originMs ?? NSNull(),
          ])
        }
      } catch {
        emit("error", ["where": "transcriber", "message": "\(error)"])
      }
    })
    tasks.append(Task {
      do {
        for try await result in detector.results {
          emit("speech", [
            "detected": result.speechDetected,
            "startMs": Self.ms(result.range.start),
            "endMs": Self.ms(result.range.end),
            "originMs": recent.originMs ?? NSNull(),
          ])
        }
      } catch {
        emit("error", ["where": "detector", "message": "\(error)"])
      }
    })
    return format
  }

  /// The caller's turn ended at `throughMs`: publish its final transcript now
  /// instead of after the transcriber's own pause (1.5-2.1 s measured). Only
  /// at a real turn end: forcing it at a mid-sentence pause garbled the words
  /// either side of it ("I'll meet you" came back as "....").
  func finalize(throughMs: Int) async {
    try? await analyzer?.finalize(through: CMTime(value: CMTimeValue(throughMs), timescale: 1000))
  }

  func feed(_ buffer: AVAudioPCMBuffer) {
    input?.yield(AnalyzerInput(buffer: buffer))
    recent.append(buffer)
  }

  func stop() async {
    input?.finish()
    input = nil
    try? await analyzer?.finalizeAndFinishThroughEndOfInput()
    analyzer = nil
    format = nil
    for task in tasks { task.cancel() }
    tasks = []
  }

  private static func ms(_ time: CMTime) -> Int {
    time.isNumeric ? Int((time.seconds * 1000).rounded()) : 0
  }
}
