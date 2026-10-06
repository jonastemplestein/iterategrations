package main

import (
	"math"
	"testing"
	"time"

	"github.com/zaf/g711"
)

// A-law against an independent implementation, every input.
func TestAlawMatchesReference(t *testing.T) {
	for value := math.MinInt16; value <= math.MaxInt16; value++ {
		sample := int16(value)
		want := g711.EncodeAlawFrame(sample)
		if got := alawEncode(sample); got != want {
			t.Fatalf("encode %d: got %#x, want %#x", sample, got, want)
		}
	}
	for code := 0; code < 256; code++ {
		want := g711.DecodeAlawFrame(uint8(code))
		if got := alawDecode(byte(code)); got != want {
			t.Fatalf("decode %#x: got %d, want %d", code, got, want)
		}
	}
	if alawEncode(0) != alawSilence {
		t.Fatalf("silence is %#x", alawEncode(0))
	}
}

func tone(hz float64, rate int, samples int, amplitude float64) []int16 {
	out := make([]int16, samples)
	for i := range out {
		out[i] = int16(amplitude * math.Sin(2*math.Pi*hz*float64(i)/float64(rate)))
	}
	return out
}

func rms(samples []int16) float64 {
	sum := 0.0
	for _, s := range samples {
		sum += float64(s) * float64(s)
	}
	return math.Sqrt(sum / float64(len(samples)))
}

// the amplitude of one frequency in samples (Goertzel): a sine of amplitude A answers A.
func level(samples []int16, hz float64, rate int) float64 {
	w := 2 * math.Pi * hz / float64(rate)
	var s1, s2 float64
	for _, x := range samples {
		s0 := float64(x) + 2*math.Cos(w)*s1 - s2
		s2, s1 = s1, s0
	}
	power := s1*s1 + s2*s2 - 2*math.Cos(w)*s1*s2
	return 2 * math.Sqrt(power) / float64(len(samples))
}

func db(ratio float64) float64 { return 20 * math.Log10(ratio) }

// in frames, as a call runs them
func downInFrames(in []int16) []int16 {
	d := newDownsampler()
	var out []int16
	for at := 0; at+voiceFrame <= len(in); at += voiceFrame {
		out = append(out, d.process(in[at:at+voiceFrame])...)
	}
	return out
}

func upInFrames(in []int16) []int16 {
	u := newUpsampler()
	var out []int16
	for at := 0; at+lineFrameSamples <= len(in); at += lineFrameSamples {
		out = append(out, u.process(in[at:at+lineFrameSamples])...)
	}
	return out
}

// The voice's speech keeps its level going down to the line; what the line cannot carry (above
// 4 kHz) is filtered out instead of folding back as a whistle.
func TestDownsampleKeepsSpeechAndRemovesAliases(t *testing.T) {
	speech := downInFrames(tone(1000, voiceRate, voiceRate, 10000)) // one second
	if len(speech) != lineRate {
		t.Fatalf("%d samples out of one second", len(speech))
	}
	settled := speech[100:]
	if change := db(rms(settled) / (10000 / math.Sqrt2)); math.Abs(change) > 0.2 {
		t.Fatalf("1 kHz changed level by %.2f dB", change)
	}
	if got := level(settled, 1000, lineRate); math.Abs(db(got/10000)) > 0.2 {
		t.Fatalf("1 kHz is %.2f dB after downsampling", db(got/10000))
	}
	// 6 kHz would fold to 2 kHz at 8 kHz
	alias := downInFrames(tone(6000, voiceRate, voiceRate, 10000))[100:]
	if attenuation := db(rms(alias) / (10000 / math.Sqrt2)); attenuation > -50 {
		t.Fatalf("6 kHz came through at %.1f dB", attenuation)
	}
}

// The person's voice keeps its level going up to 16 kHz, with no mirror image above 4 kHz.
func TestUpsampleKeepsSpeechAndRemovesImages(t *testing.T) {
	up := upInFrames(tone(1000, lineRate, lineRate, 10000))
	if len(up) != voiceRate {
		t.Fatalf("%d samples out of one second", len(up))
	}
	settled := up[200:]
	if got := level(settled, 1000, voiceRate); math.Abs(db(got/10000)) > 0.2 {
		t.Fatalf("1 kHz is %.2f dB after upsampling", db(got/10000))
	}
	if image := level(settled, 7000, voiceRate); db(image/10000) > -50 {
		t.Fatalf("the 7 kHz image is %.1f dB", db(image/10000))
	}
}

// Frame by frame is the same as all at once: no clicks at the joins.
func TestResamplersCarryStateAcrossFrames(t *testing.T) {
	in := tone(440, voiceRate, 4*voiceFrame, 12000)
	whole := newDownsampler().process(in)
	framed := downInFrames(in)
	for i := range whole {
		if whole[i] != framed[i] {
			t.Fatalf("sample %d: %d whole, %d in frames", i, whole[i], framed[i])
		}
	}
	line := tone(440, lineRate, 4*lineFrameSamples, 12000)
	wholeUp := newUpsampler().process(line)
	framedUp := upInFrames(line)
	for i := range wholeUp {
		if wholeUp[i] != framedUp[i] {
			t.Fatalf("up sample %d: %d whole, %d in frames", i, wholeUp[i], framedUp[i])
		}
	}
}

// The whole way, voice to line to voice, through A-law: what is said is what is heard.
func TestRoundTripThroughTheLine(t *testing.T) {
	voice := tone(700, voiceRate, voiceRate, 8000)
	line := downInFrames(voice)
	for i, s := range line {
		line[i] = alawDecode(alawEncode(s))
	}
	back := upInFrames(line)[400:]
	if got := level(back, 700, voiceRate); math.Abs(db(got/8000)) > 0.5 {
		t.Fatalf("700 Hz came back at %.2f dB", db(got/8000))
	}
}

// serve.go's playout rules, on 20 ms frames.
func TestVoiceQueue(t *testing.T) {
	pcm := func(samples int) []byte { return make([]byte, 2*samples) }
	q := newVoiceQueue()
	if q.readFrame() != nil {
		t.Fatal("an empty queue played")
	}
	q.push(pcm(voiceFrame)) // 20 ms: gathers until 180 ms or 240 ms
	if q.readFrame() != nil {
		t.Fatal("played before enough was queued")
	}
	q.push(pcm(startPlayingAfterSamples))
	if q.readFrame() == nil {
		t.Fatal("did not play with 200 ms queued")
	}
	for q.readFrame() != nil {
	}
	if stats := q.snapshot(); stats.Underruns != 1 || stats.FramesPlayed != 10 || stats.MaxQueuedMs != 200 {
		t.Fatalf("stats %+v", stats)
	}
	// a short complete answer plays at once, and ends without an underrun
	q.push(pcm(voiceFrame / 2))
	q.last()
	if frame := q.readFrame(); len(frame) != voiceFrame {
		t.Fatal("a complete answer waited")
	}
	if q.readFrame() != nil || q.snapshot().Underruns != 1 {
		t.Fatal("a complete answer counted as a gap")
	}
	// a short answer still plays once it has waited long enough
	q.push(pcm(voiceFrame))
	time.Sleep(startPlayingAfter + 10*time.Millisecond)
	if q.readFrame() == nil {
		t.Fatal("a short answer never played")
	}
	// the person spoke over it: dropped
	q.push(pcm(10 * voiceFrame))
	q.clear()
	if q.readFrame() != nil || q.snapshot().Cleared != 1 {
		t.Fatal("clear left audio queued")
	}
	if q.snapshot().FrameMs != 20 {
		t.Fatal("frameMs")
	}
}

func TestCallerNumber(t *testing.T) {
	cases := []struct {
		raw     string
		number  string
		trusted bool
	}{
		{"07477472160", "447477472160", true},
		{"+447477472160", "447477472160", true},
		{"00447852559254", "447852559254", true},
		{"447477472160", "447477472160", true},
		{"?+447477472160", "", false}, // an untrusted caller ID never counts as the number it claims
		{"?phonetest", "", false},
		{"%3fphonetest", "", false}, // as the line sends it
		{"%3f+447477472160", "", false},
		{"%2b447477472160", "447477472160", true},
		{"anonymous", "", false},
		{"", "", false},
		{"jonas", "", false},
		{"0747747216x", "", false},
		{"123", "", false},
	}
	for _, c := range cases {
		number, trusted := callerNumber(c.raw)
		if number != c.number || trusted != c.trusted {
			t.Errorf("callerNumber(%q) = %q, %v; want %q, %v", c.raw, number, trusted, c.number, c.trusted)
		}
	}
}
