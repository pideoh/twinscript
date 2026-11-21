// Captures the system audio of the main display with ScreenCaptureKit and writes it to stdout as
// raw little-endian Float32 mono PCM at 48 kHz, until it gets SIGTERM or stdin is closed.
//
// Exit codes (mirrored in app/system-audio.js):
//   0  stopped on request (SIGTERM / stdin closed / stdout closed)
//   1  any other failure (one line on stderr)
//   2  Screen Recording permission not granted
//   3  macOS older than 13
//
// Built by scripts/build-mac-helper.sh.
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

let exitError: Int32 = 1
let exitPermission: Int32 = 2
let exitUnsupported: Int32 = 3
let sampleRate = 48000

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

// SCStreamError.userDeclined: the user (or the system, for lack of permission) refused capture.
func isPermissionError(_ error: Error) -> Bool {
  let ns = error as NSError
  return ns.domain == SCStreamErrorDomain && ns.code == SCStreamError.Code.userDeclined.rawValue
}

func writeAll(_ pointer: UnsafeRawPointer, _ count: Int) {
  var offset = 0
  while offset < count {
    let n = write(STDOUT_FILENO, pointer + offset, count - offset)
    if n < 0 {
      if errno == EINTR { continue }
      exit(0) // the reader went away
    }
    offset += n
  }
}

@available(macOS 13.0, *)
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
  private var stream: SCStream?
  private let queue = DispatchQueue(label: "system-audio.samples")
  private var mono = [Float]()

  func start() {
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
      if let error = error {
        if isPermissionError(error) { fail(exitPermission, "screen recording permission denied: \(error.localizedDescription)") }
        fail(exitError, "cannot list displays: \(error.localizedDescription)")
      }
      let main = CGMainDisplayID()
      guard let display = content?.displays.first(where: { $0.displayID == main }) ?? content?.displays.first else {
        fail(exitError, "no display to capture")
      }
      let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
      let config = SCStreamConfiguration()
      config.capturesAudio = true
      config.excludesCurrentProcessAudio = true
      config.sampleRate = sampleRate
      config.channelCount = 1
      // Video cannot be turned off; keep it as small and as rare as possible and discard it.
      config.width = 2
      config.height = 2
      config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
      config.queueDepth = 3
      config.showsCursor = false

      let stream = SCStream(filter: filter, configuration: config, delegate: self)
      do {
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.queue)
      } catch {
        fail(exitError, "cannot add stream output: \(error.localizedDescription)")
      }
      self.stream = stream
      stream.startCapture { error in
        guard let error = error else { return }
        if isPermissionError(error) { fail(exitPermission, "screen recording permission denied: \(error.localizedDescription)") }
        fail(exitError, "cannot start capture: \(error.localizedDescription)")
      }
    }
  }

  func stop() {
    stream?.stopCapture { _ in exit(0) }
    // Do not wait for ever if the stream does not answer.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(0) }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    if isPermissionError(error) { fail(exitPermission, "screen recording permission denied: \(error.localizedDescription)") }
    fail(exitError, "capture stopped: \(error.localizedDescription)")
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, sampleBuffer.isValid,
          let format = CMSampleBufferGetFormatDescription(sampleBuffer),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee else { return }
    guard asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else {
      fail(exitError, "unexpected audio format (flags \(asbd.mFormatFlags), \(asbd.mBitsPerChannel) bits)")
    }
    if Int(asbd.mSampleRate) != sampleRate { fail(exitError, "unexpected sample rate \(asbd.mSampleRate)") }
    let frames = CMSampleBufferGetNumSamples(sampleBuffer)
    if frames <= 0 { return }
    let interleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    do {
      try sampleBuffer.withAudioBufferList { list, _ in
        if mono.count != frames { mono = [Float](repeating: 0, count: frames) }
        for i in 0..<frames { mono[i] = 0 }
        var used = 0
        for buffer in list {
          guard let data = buffer.mData else { continue }
          let samples = data.assumingMemoryBound(to: Float.self)
          let stride = interleaved ? Int(buffer.mNumberChannels) : 1
          let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size / max(1, stride)
          for c in 0..<max(1, stride) {
            for i in 0..<min(frames, count) { mono[i] += samples[i * stride + c] }
            used += 1
          }
        }
        if used > 1 {
          let scale = 1 / Float(used)
          for i in 0..<frames { mono[i] *= scale }
        }
        mono.withUnsafeBytes { writeAll($0.baseAddress!, $0.count) }
      }
    } catch {
      fail(exitError, "cannot read audio: \(error.localizedDescription)")
    }
  }
}

@available(macOS 13.0, *)
func run() -> Never {
  // Without the permission the capture would only fail later (or deliver nothing); ask the system
  // to list the app under Screen Recording and report it right away.
  if !CGPreflightScreenCaptureAccess() {
    _ = CGRequestScreenCaptureAccess()
    fail(exitPermission, "screen recording permission not granted")
  }

  let capture = Capture()
  signal(SIGTERM, SIG_IGN)
  signal(SIGINT, SIG_IGN)
  var signalSources = [DispatchSourceSignal]()
  for sig in [SIGTERM, SIGINT] {
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { capture.stop() }
    source.resume()
    signalSources.append(source)
  }

  // The parent closes stdin (or dies) when it no longer wants audio.
  Thread.detachNewThread {
    var bytes = [UInt8](repeating: 0, count: 64)
    while read(STDIN_FILENO, &bytes, bytes.count) > 0 {}
    DispatchQueue.main.async { capture.stop() }
  }

  capture.start()
  withExtendedLifetime(signalSources) { dispatchMain() }
}

signal(SIGPIPE, SIG_IGN)
if #available(macOS 13.0, *) { run() }
fail(exitUnsupported, "macOS 13 or later is required")
