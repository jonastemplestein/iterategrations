// codec.go — the line's audio and the voice processor's: G.711 A-law at 8 kHz (all Andrews &
// Arnold's VoIP carries, 20 ms to a packet) on one side, 16 kHz mono PCM16 on the other.
//
//	the person -> A-law 8 kHz -> decode -> upsample 2x -> 16 kHz PCM16 (mic)
//	the voice  -> 16 kHz PCM16 -> low-pass and downsample 2x -> encode -> A-law 8 kHz
//
// Both resamplers run one low-pass FIR (cut at 3.6 kHz, below the 4 kHz the 8 kHz side can carry)
// and keep their history between frames, so a call's frames join with no clicks.
package main

import "math"

// lineRate and voiceRate are the sample rates of the line (A-law) and of the voice processor.
const (
	lineRate  = 8000
	voiceRate = 16000
	// frameMs is the line's packet: 20 ms, 160 samples at 8 kHz, 320 at 16 kHz.
	frameMs          = 20
	lineFrameSamples = lineRate * frameMs / 1000
	voiceFrame       = voiceRate * frameMs / 1000
	// micFrameSamples is what one `mic` line carries: 60 ms at 16 kHz, as the WhatsApp bridge sends.
	micFrameSamples = 3 * voiceFrame
)

// alawSilence is A-law's code for zero.
const alawSilence = 0xD5

var alawSegmentEnds = [8]int{0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF}

// alawEncode turns one linear sample into its A-law code (ITU-T G.711, as Sun's reference g711.c).
func alawEncode(sample int16) byte {
	value := int(sample) >> 3
	mask := byte(0xD5)
	if value < 0 {
		mask = 0x55
		value = -value - 1
	}
	segment := 0
	for segment < 8 && value > alawSegmentEnds[segment] {
		segment++
	}
	if segment >= 8 {
		return 0x7F ^ mask
	}
	code := byte(segment << 4)
	if segment < 2 {
		code |= byte(value>>1) & 0x0F
	} else {
		code |= byte(value>>segment) & 0x0F
	}
	return code ^ mask
}

// alawDecode turns one A-law code back into a linear sample.
func alawDecode(code byte) int16 {
	code ^= 0x55
	value := int(code&0x0F) << 4
	segment := int(code&0x70) >> 4
	switch segment {
	case 0:
		value += 8
	case 1:
		value += 0x108
	default:
		value += 0x108
		value <<= segment - 1
	}
	if code&0x80 != 0 {
		return int16(value)
	}
	return int16(-value)
}

// lowPass is the resamplers' filter at 16 kHz: a windowed sinc (Blackman), 63 taps, cut at 3.6 kHz,
// unity gain at 0 Hz.
var lowPass = func() []float64 {
	const taps = 63
	const cutoff = 3600.0 / voiceRate // cycles a sample
	h := make([]float64, taps)
	sum := 0.0
	for n := range h {
		x := float64(n) - float64(taps-1)/2
		sinc := 2 * cutoff
		if x != 0 {
			sinc = math.Sin(2*math.Pi*cutoff*x) / (math.Pi * x)
		}
		window := 0.42 - 0.5*math.Cos(2*math.Pi*float64(n)/float64(taps-1)) + 0.08*math.Cos(4*math.Pi*float64(n)/float64(taps-1))
		h[n] = sinc * window
		sum += h[n]
	}
	for n := range h {
		h[n] /= sum
	}
	return h
}()

func clip16(value float64) int16 {
	value = math.Round(value)
	if value > math.MaxInt16 {
		return math.MaxInt16
	}
	if value < math.MinInt16 {
		return math.MinInt16
	}
	return int16(value)
}

// downsampler takes 16 kHz audio to 8 kHz: low-pass, then every other sample.
type downsampler struct{ history []float64 }

func newDownsampler() *downsampler {
	return &downsampler{history: make([]float64, len(lowPass)-1)}
}

// process answers len(in)/2 samples at 8 kHz; len(in) must be even.
func (d *downsampler) process(in []int16) []int16 {
	taps := len(lowPass)
	buffer := make([]float64, len(d.history)+len(in))
	copy(buffer, d.history)
	for i, sample := range in {
		buffer[len(d.history)+i] = float64(sample)
	}
	out := make([]int16, len(in)/2)
	for i := range out {
		at := len(d.history) + 2*i + 1 // the newest input sample this output sees
		acc := 0.0
		for k := 0; k < taps; k++ {
			acc += lowPass[k] * buffer[at-k]
		}
		out[i] = clip16(acc)
	}
	copy(d.history, buffer[len(buffer)-len(d.history):])
	return out
}

// upsampler takes 8 kHz audio to 16 kHz: a zero between every two samples, then the low-pass
// (at twice the gain, for the zeros).
type upsampler struct{ history []float64 }

func newUpsampler() *upsampler {
	return &upsampler{history: make([]float64, len(lowPass)-1)}
}

// process answers 2*len(in) samples at 16 kHz.
func (u *upsampler) process(in []int16) []int16 {
	taps := len(lowPass)
	buffer := make([]float64, len(u.history)+2*len(in))
	copy(buffer, u.history)
	for i, sample := range in {
		buffer[len(u.history)+2*i] = float64(sample)
	}
	out := make([]int16, 2*len(in))
	for i := range out {
		at := len(u.history) + i
		acc := 0.0
		for k := 0; k < taps; k++ {
			acc += lowPass[k] * buffer[at-k]
		}
		out[i] = clip16(2 * acc)
	}
	copy(u.history, buffer[len(buffer)-len(u.history):])
	return out
}
