// queue.go — the voice's audio on its way to the line: serve.go's voiceQueue of the WhatsApp
// bridge (whatsapp-calls/serve.go), with the same start, `last` and `clear` rules and the same
// stats, for a line that plays one 20 ms frame every 20 ms.
package main

import (
	"encoding/binary"
	"sync"
	"time"
)

// The voice's audio reaches this process in bursts and with the network's jitter: an answer starts
// playing once this much of it is queued (or it has waited this long, or it is already complete),
// so a late burst is absorbed by the queue and not heard as a gap. The same 180 ms and 240 ms as
// the WhatsApp bridge.
const (
	startPlayingAfterSamples = 180 * voiceRate / 1000
	startPlayingAfter        = 240 * time.Millisecond
)

// voiceStats is what the queue saw of one call, for the call's report. The fields are the WhatsApp
// bridge's; a frame here is 20 ms (FrameMs says so), not WhatsApp's 60.
type voiceStats struct {
	FrameMs int `json:"frameMs"`
	// FramesPlayed and FramesHeard count frames: said to the person, and heard from them.
	FramesPlayed int `json:"framesPlayed"`
	FramesHeard  int `json:"framesHeard"`
	// Underruns counts the times the queue ran dry in the middle of an answer: an audible gap.
	Underruns int `json:"underruns"`
	// MaxQueuedMs is the most audio that ever waited to be played.
	MaxQueuedMs int `json:"maxQueuedMs"`
	// Cleared counts the times queued audio was dropped because the person spoke over it.
	Cleared int `json:"cleared"`
}

// voiceQueue is what the parent has sent to say and the line has not yet played, at 16 kHz. With
// nothing to play, readFrame answers nil and the line sends silence.
type voiceQueue struct {
	mu          sync.Mutex
	samples     []int16
	playing     bool      // false while an answer's first frames gather
	waitingFrom time.Time // when the answer now gathering got its first samples
	complete    bool      // the parent said nothing more is coming for this answer
	stats       voiceStats
}

func newVoiceQueue() *voiceQueue { return &voiceQueue{stats: voiceStats{FrameMs: frameMs}} }

// push queues PCM16 little-endian audio at 16 kHz.
func (q *voiceQueue) push(pcm []byte) {
	samples := make([]int16, len(pcm)/2)
	for i := range samples {
		samples[i] = int16(binary.LittleEndian.Uint16(pcm[2*i:]))
	}
	q.mu.Lock()
	if len(q.samples) == 0 && !q.playing {
		q.waitingFrom = time.Now()
	}
	q.complete = false
	q.samples = append(q.samples, samples...)
	if queued := len(q.samples) * 1000 / voiceRate; queued > q.stats.MaxQueuedMs {
		q.stats.MaxQueuedMs = queued
	}
	q.mu.Unlock()
}

// last marks the answer complete: its tail plays out without waiting for more.
func (q *voiceQueue) last() {
	q.mu.Lock()
	q.complete = true
	q.mu.Unlock()
}

func (q *voiceQueue) clear() {
	q.mu.Lock()
	if len(q.samples) > 0 {
		q.stats.Cleared++
	}
	q.samples = nil
	q.playing = false
	q.complete = false
	q.mu.Unlock()
}

func (q *voiceQueue) heard() {
	q.mu.Lock()
	q.stats.FramesHeard++
	q.mu.Unlock()
}

func (q *voiceQueue) snapshot() voiceStats {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.stats
}

// readFrame is pulled once a frame interval by the line's send loop: one 20 ms frame at 16 kHz, or
// nil for silence.
func (q *voiceQueue) readFrame() []int16 {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.samples) == 0 {
		if q.playing && !q.complete {
			q.stats.Underruns++ // ran dry mid-answer: gather again before going on
		}
		q.playing = false
		q.complete = false
		return nil
	}
	if !q.playing {
		if len(q.samples) < startPlayingAfterSamples && !q.complete && time.Since(q.waitingFrom) < startPlayingAfter {
			return nil
		}
		q.playing = true
	}
	frame := make([]int16, voiceFrame) // a last partial frame is padded with silence
	taken := copy(frame, q.samples)
	q.samples = q.samples[taken:]
	q.stats.FramesPlayed++
	return frame
}
