// serve_test.go — the bridge against a real SIP peer on loopback (diago, as a phone would be):
// an incoming call is announced, answered on the parent's word, carries audio both ways and ends
// when the person hangs up; a caller who gives up, a call turned away, a call with no audio; a
// placed call rings, is answered, carries audio and is hung up; a placed call nobody answers.
// The real line is tested by hand (README).
package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emiago/diago"
	"github.com/emiago/diago/media"
	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/rs/zerolog"
)

var nextPort atomic.Int32

func init() { nextPort.Store(25060) }

type harness struct {
	t      *testing.T
	ctx    context.Context
	server *server
	events chan map[string]any
	mu     sync.Mutex
	mic    []int16 // every mic frame, 16 kHz
	peer   *diago.Diago
	// where the server listens, and the peer
	serverAddr, peerAddr string
}

// newHarness starts a bridge and a peer on loopback; onCall is the peer's answer to a call the
// bridge places.
func newHarness(t *testing.T, onCall func(d *diago.DialogServerSession)) *harness {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	logger := zerolog.New(zerolog.NewTestWriter(t)).Level(zerolog.WarnLevel)
	ctx = logger.WithContext(ctx)
	serverPort, peerPort := int(nextPort.Add(2)), int(nextPort.Load()+1)
	h := &harness{t: t, ctx: ctx, events: make(chan map[string]any, 4096),
		serverAddr: fmt.Sprintf("127.0.0.1:%d", serverPort), peerAddr: fmt.Sprintf("127.0.0.1:%d", peerPort)}
	conf := lineConfig{
		Number: "+447441138737", Domain: "127.0.0.1", Proxy: h.peerAddr,
		BindIP: "127.0.0.1", Port: serverPort,
		RingLimit: 10 * time.Second, AudioAfterAnswer: 1500 * time.Millisecond, SilentLine: 3 * time.Second,
	}
	s, err := newServer(ctx, conf, func(event map[string]any) {
		if event["event"] == "mic" {
			pcm, _ := base64.StdEncoding.DecodeString(event["pcm"].(string))
			h.mu.Lock()
			for i := 0; i+1 < len(pcm); i += 2 {
				h.mic = append(h.mic, int16(binary.LittleEndian.Uint16(pcm[i:])))
			}
			h.mu.Unlock()
			return
		}
		h.events <- event
	})
	if err != nil {
		t.Fatal(err)
	}
	h.server = s
	h.expect("ready")
	ua, _ := sipgo.NewUA(sipgo.WithUserAgent("07477472160"), sipgo.WithUserAgentHostname("127.0.0.1"))
	h.peer = diago.NewDiago(ua,
		diago.WithLogger(diagoLogger()),
		diago.WithTransport(diago.Transport{Transport: "udp", BindHost: "127.0.0.1", BindPort: peerPort}),
		diago.WithMediaConfig(diago.MediaConfig{Codecs: lineCodecs}),
	)
	if onCall == nil {
		onCall = func(d *diago.DialogServerSession) {}
	}
	if err := h.peer.ServeBackground(ctx, onCall); err != nil {
		t.Fatal(err)
	}
	return h
}

// expect waits for the next event of this kind; events of other kinds before it fail the test.
func (h *harness) expect(kind string) map[string]any {
	h.t.Helper()
	select {
	case event := <-h.events:
		if event["event"] != kind {
			h.t.Fatalf("waiting for %q, got %v", kind, event)
		}
		return event
	case <-time.After(15 * time.Second):
		h.t.Fatalf("timed out waiting for %q", kind)
	}
	return nil
}

func (h *harness) micHeard() []int16 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]int16(nil), h.mic...)
}

// dial is the peer ringing the bridge; it answers once the call is up (or refused).
func (h *harness) dial(ctx context.Context) (*diago.DialogClientSession, *diago.DialogMedia, error) {
	// the address in the URI, not as a destination: a CANCEL goes where the URI says
	d, err := h.peer.NewDialog(sip.Uri{Scheme: "sip", User: "+447441138737", Host: "127.0.0.1", Port: h.server.conf.Port}, diago.NewDialogOptions{})
	if err != nil {
		return nil, nil, err
	}
	med, err := d.Invite(ctx, diago.InviteClientOptions{})
	if err != nil {
		return d, nil, err
	}
	return d, med, d.Ack(ctx)
}

// talk sends a tone from the peer, 20 ms a packet, until ctx ends.
func talk(ctx context.Context, med *diago.DialogMedia, hz float64) {
	writer, err := med.AudioWriter()
	if err != nil {
		return
	}
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	samples := tone(hz, lineRate, 10*lineRate, 12000)
	for at := 0; at+lineFrameSamples <= len(samples); at += lineFrameSamples {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		payload := make([]byte, lineFrameSamples)
		for i, s := range samples[at : at+lineFrameSamples] {
			payload[i] = alawEncode(s)
		}
		if _, err := writer.Write(payload); err != nil {
			return
		}
	}
}

// listen records what the peer hears (8 kHz) until the media closes.
func listen(med *diago.DialogMedia) func() []int16 {
	var mu sync.Mutex
	var heard []int16
	go func() {
		buf := make([]byte, media.RTPBufSize)
		for {
			n, err := med.RTPPacketReader.Read(buf)
			if err != nil {
				return
			}
			mu.Lock()
			for _, code := range buf[:n] {
				heard = append(heard, alawDecode(code))
			}
			mu.Unlock()
		}
	}()
	return func() []int16 {
		mu.Lock()
		defer mu.Unlock()
		return append([]int16(nil), heard...)
	}
}

// say is the parent sending the voice's answer: one second of a tone at 16 kHz, in 60 ms lines.
func say(s *server, hz float64) {
	samples := tone(hz, voiceRate, voiceRate, 12000)
	for at := 0; at < len(samples); at += 960 {
		chunk := samples[at:min(at+960, len(samples))]
		pcm := make([]byte, 2*len(chunk))
		for i, v := range chunk {
			binary.LittleEndian.PutUint16(pcm[2*i:], uint16(v))
		}
		s.handle(serveInput{PCM: base64.StdEncoding.EncodeToString(pcm), Last: at+960 >= len(samples)})
	}
}

func loud(t *testing.T, what string, samples []int16, hz float64, rate int) {
	t.Helper()
	if len(samples) < rate/2 {
		t.Fatalf("%s: only %d samples", what, len(samples))
	}
	if amplitude := level(samples, hz, rate); amplitude < 6000 {
		t.Fatalf("%s: %v Hz at amplitude %.0f (want about 12000)", what, hz, amplitude)
	}
}

func TestIncomingCallCarriesAudioBothWays(t *testing.T) {
	h := newHarness(t, nil)
	type dialled struct {
		d   *diago.DialogClientSession
		med *diago.DialogMedia
		err error
	}
	answered := make(chan dialled, 1)
	go func() {
		d, med, err := h.dial(h.ctx)
		answered <- dialled{d, med, err}
	}()
	incoming := h.expect("incoming")
	if incoming["number"] != "447477472160" || incoming["untrusted"] != false || incoming["from"] != "07477472160" {
		t.Fatalf("incoming %v", incoming)
	}
	callID := incoming["callId"].(string)
	h.server.handle(serveInput{Answer: callID})
	call := <-answered
	if call.err != nil {
		t.Fatal(call.err)
	}
	if up := h.expect("answered"); up["callId"] != callID {
		t.Fatalf("answered %v", up)
	}
	heard := listen(call.med)
	talking, stop := context.WithCancel(h.ctx)
	go talk(talking, call.med, 1000)
	say(h.server, 440)
	time.Sleep(1500 * time.Millisecond)
	stop()
	loud(t, "the bridge heard the person", h.micHeard()[1600:], 1000, voiceRate)
	loud(t, "the person heard the voice", trimSilence(heard()), 440, lineRate)
	if err := call.d.Hangup(h.ctx); err != nil {
		t.Fatal(err)
	}
	ended := h.expect("ended")
	if ended["reason"] != "the person hung up" || ended["answered"] != true || ended["callId"] != callID {
		t.Fatalf("ended %v", ended)
	}
	stats := ended["stats"].(voiceStats)
	if stats.FramesHeard < 40 || stats.FramesPlayed < 45 || stats.FrameMs != 20 {
		t.Fatalf("stats %+v", stats)
	}
}

func trimSilence(samples []int16) []int16 {
	start, end := 0, len(samples)
	for start < end && math.Abs(float64(samples[start])) < 500 {
		start++
	}
	for end > start && math.Abs(float64(samples[end-1])) < 500 {
		end--
	}
	return samples[start:end]
}

func TestCallerHangsUpWhileItRings(t *testing.T) {
	h := newHarness(t, nil)
	ringing, giveUp := context.WithCancel(h.ctx)
	done := make(chan error, 1)
	go func() {
		_, _, err := h.dial(ringing)
		done <- err
	}()
	incoming := h.expect("incoming")
	time.Sleep(300 * time.Millisecond)
	giveUp()
	ended := h.expect("ended")
	if ended["reason"] != "the caller hung up before it was answered" || ended["callId"] != incoming["callId"] || ended["answered"] != false {
		t.Fatalf("ended %v", ended)
	}
	if err := <-done; err == nil {
		t.Fatal("the call was answered")
	}
}

func TestRejectedCallGoesToTheLinesFallback(t *testing.T) {
	h := newHarness(t, nil)
	done := make(chan error, 1)
	go func() {
		_, _, err := h.dial(h.ctx)
		done <- err
	}()
	incoming := h.expect("incoming")
	h.server.handle(serveInput{Reject: incoming["callId"].(string)})
	if err := <-done; refusal(err) == nil || refusal(err).StatusCode != sip.StatusTemporarilyUnavailable {
		t.Fatalf("the caller got %v, want 480", err)
	}
	if ended := h.expect("ended"); ended["reason"] != "turned away" {
		t.Fatalf("ended %v", ended)
	}
}

func TestAnsweredCallWithNoAudioIsEnded(t *testing.T) {
	h := newHarness(t, nil)
	go func() { _, _, _ = h.dial(h.ctx) }() // a caller that sends nothing
	incoming := h.expect("incoming")
	h.server.handle(serveInput{Answer: incoming["callId"].(string)})
	h.expect("answered")
	if ended := h.expect("ended"); ended["reason"] != noAudio {
		t.Fatalf("ended %v", ended)
	}
}

func TestPlacedCallRingsIsAnsweredAndHungUp(t *testing.T) {
	gotCall := make(chan *diago.DialogServerSession, 1)
	h := newHarness(t, func(d *diago.DialogServerSession) {
		gotCall <- d
		_ = d.Ringing()
		time.Sleep(300 * time.Millisecond)
		med, err := d.Answer(diago.AnswerOptions{Codecs: lineCodecs})
		if err != nil {
			return
		}
		go talk(d.Context(), med, 1000)
		<-d.Context().Done()
	})
	h.server.handle(serveInput{Call: "+447700900001", Ring: 10})
	ringing := h.expect("ringing")
	d := <-gotCall
	if d.ToUser() != "+447700900001" || d.FromUser() != "+447441138737" {
		t.Fatalf("the call went to %q from %q", d.ToUser(), d.FromUser())
	}
	if up := h.expect("answered"); up["callId"] != ringing["callId"] {
		t.Fatalf("answered %v", up)
	}
	time.Sleep(1200 * time.Millisecond)
	loud(t, "the bridge heard the person", h.micHeard()[1600:], 1000, voiceRate)
	// busy: a second call is refused while this one is up
	h.server.handle(serveInput{Call: "+447700900002"})
	if failed := h.expect("failed"); failed["reason"] != "a call is already in progress" {
		t.Fatalf("failed %v", failed)
	}
	h.server.handle(serveInput{Hangup: true})
	ended := h.expect("ended")
	if ended["reason"] != "hung up" || ended["answered"] != true {
		t.Fatalf("ended %v", ended)
	}
	select {
	case <-d.Context().Done():
	case <-time.After(3 * time.Second):
		t.Fatal("the peer never got the BYE")
	}
}

func TestPlacedCallNobodyAnswers(t *testing.T) {
	h := newHarness(t, func(d *diago.DialogServerSession) {
		_ = d.Ringing()
		<-d.Context().Done()
	})
	h.server.handle(serveInput{Call: "+447700900001", Ring: 1})
	h.expect("ringing")
	if ended := h.expect("ended"); ended["reason"] != "no answer" || ended["answered"] != false {
		t.Fatalf("ended %v", ended)
	}
	// and the line is free again
	time.Sleep(200 * time.Millisecond)
	h.server.handle(serveInput{Call: "+447700900001", Ring: 1})
	h.expect("ringing")
	h.expect("ended")
}

func TestPlacedCallRefused(t *testing.T) {
	h := newHarness(t, func(d *diago.DialogServerSession) {
		_ = d.Respond(sip.StatusBusyHere, "Busy Here", nil)
	})
	h.server.handle(serveInput{Call: "+447700900001", Ring: 5})
	if failed := h.expect("failed"); failed["reason"] != "busy" {
		t.Fatalf("failed %v", failed)
	}
}
