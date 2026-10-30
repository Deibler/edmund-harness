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
    tasks.append(Task {
      do {
        for try await result in transcriber.results {
          emit("transcript", [
            "text": String(result.text.characters),
            "final": result.isFinal,
            "startMs": Self.ms(result.range.start),
            "endMs": Self.ms(result.range.end),
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
          ])
        }
      } catch {
        emit("error", ["where": "detector", "message": "\(error)"])
      }
    })
    return format
  }

  func feed(_ buffer: AVAudioPCMBuffer) {
    input?.yield(AnalyzerInput(buffer: buffer))
  }

  func stop() async {
    input?.finish()
    input = nil
    try? await analyzer?.finalizeAndFinishThroughEndOfInput()
    analyzer = nil
    for task in tasks { task.cancel() }
    tasks = []
  }

  private static func ms(_ time: CMTime) -> Int {
    time.isNumeric ? Int((time.seconds * 1000).rounded()) : 0
  }
}
