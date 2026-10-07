// wav.go — mono PCM16 WAV files, for the test caller (dial.go) and the tests.
package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
)

// readWAV answers a mono PCM16 file's samples and sample rate.
func readWAV(path string) ([]int16, int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, err
	}
	if len(data) < 12 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return nil, 0, fmt.Errorf("%s is not a WAV file", path)
	}
	rate, channels, bits := 0, 0, 0
	for at := 12; at+8 <= len(data); {
		id := string(data[at : at+4])
		size := int(binary.LittleEndian.Uint32(data[at+4:]))
		body := data[at+8 : min(len(data), at+8+size)]
		switch id {
		case "fmt ":
			if len(body) < 16 {
				return nil, 0, errors.New("short fmt chunk")
			}
			channels = int(binary.LittleEndian.Uint16(body[2:]))
			rate = int(binary.LittleEndian.Uint32(body[4:]))
			bits = int(binary.LittleEndian.Uint16(body[14:]))
		case "data":
			if channels != 1 || bits != 16 {
				return nil, 0, fmt.Errorf("%s is %d channels at %d bits: want mono PCM16", path, channels, bits)
			}
			samples := make([]int16, len(body)/2)
			for i := range samples {
				samples[i] = int16(binary.LittleEndian.Uint16(body[2*i:]))
			}
			return samples, rate, nil
		}
		at += 8 + size + size%2
	}
	return nil, 0, fmt.Errorf("%s has no data chunk", path)
}

// writeWAV writes samples as a mono PCM16 file.
func writeWAV(path string, samples []int16, rate int) error {
	data := make([]byte, 44+2*len(samples))
	copy(data[0:], "RIFF")
	binary.LittleEndian.PutUint32(data[4:], uint32(36+2*len(samples)))
	copy(data[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(data[16:], 16)
	binary.LittleEndian.PutUint16(data[20:], 1) // PCM
	binary.LittleEndian.PutUint16(data[22:], 1) // mono
	binary.LittleEndian.PutUint32(data[24:], uint32(rate))
	binary.LittleEndian.PutUint32(data[28:], uint32(2*rate))
	binary.LittleEndian.PutUint16(data[32:], 2)
	binary.LittleEndian.PutUint16(data[34:], 16)
	copy(data[36:], "data")
	binary.LittleEndian.PutUint32(data[40:], uint32(2*len(samples)))
	for i, sample := range samples {
		binary.LittleEndian.PutUint16(data[44+2*i:], uint16(sample))
	}
	return os.WriteFile(path, data, 0o644)
}
