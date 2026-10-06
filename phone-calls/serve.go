// serve.go — the phone line, kept registered, with its calls on stdin and stdout for a parent
// process that carries their audio somewhere else (calls.ts, which carries it to the project's
// voice processor). It speaks the WhatsApp bridge's protocol (whatsapp-calls/serve.go) line for
// line, so the two lends drive their bridges the same way: it places calls, and it is rung: an
// incoming call is announced and left ringing until the parent says to answer it (or to reject
// it, which only this bridge has). One call at a time has its audio carried. Both directions are
// JSON lines; audio is 16 kHz mono PCM16, little-endian, base64: the voice processor's own format.
//
//	stdin   {"call":"+44…","ring":45}   ring the number, giving up after `ring` seconds
//	        {"answer":"<callId>"}       answer the incoming call that was announced
//	        {"reject":"<callId>"}       turn the incoming call away (480: the line's own fallback,
//	                                    voicemail or another number, takes it)
//	        {"pcm":"…"}                 audio to say to the person, queued and played in order
//	        {"last":true}               nothing more is coming for this answer (may ride on a pcm line)
//	        {"clear":true}              drop what is queued (the person spoke over the voice)
//	        {"hangup":true}             end the call in progress
//	stdout  {"event":"ready","self":"+44…"}                   registered: calls can be placed and come in
//	        {"event":"incoming","callId":"…","number":"44…"}  someone is ringing (number: digits with
//	                                                          the country code, "" when the network
//	                                                          does not vouch for it; also "from", the
//	                                                          caller as the line gave it, "name",
//	                                                          "untrusted", "video" and "group")
//	        {"event":"ringing","callId":"…"}                  the call asked for is ringing
//	        {"event":"failed","reason":"…"}                   the call asked for could not be placed
//	        {"event":"answered","callId":"…"}                 the call is up, either direction of call
//	        {"event":"mic","pcm":"…"}                         what the person says, one 60 ms frame a line
//	        {"event":"ended","callId":"…","reason":"…","answered":true,"stats":{…}}
//
// The line is SIP over UDP (Andrews & Arnold's voiceless.aa.net.uk), audio G.711 A-law at 8 kHz in
// 20 ms packets (codec.go). A call that is up and carries no audio from the line within a few
// seconds is ended with the reason "answered, but no audio flowed", as on WhatsApp.
//
// Closing stdin ends the call in progress, unregisters and ends the process: a parent that died
// leaves no call up.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/emiago/diago"
	"github.com/emiago/diago/media"
	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/rs/zerolog"
)

// noAudio is the reason a call that is up and carries nothing from the line is ended with: the
// WhatsApp bridge's own words, which calls.ts knows.
const noAudio = "answered, but no audio flowed"

// lineCodecs is all the line is offered: A-law, and RFC 2833 digits (logged, not used).
var lineCodecs = []media.Codec{media.CodecAudioAlaw, media.CodecTelephoneEvent8000}

// lineConfig is the account and how this process reaches it.
type lineConfig struct {
	// Number is the account's number in E.164 (+447441138737): the registration's username, and
	// who a placed call is from.
	Number   string
	Password string
	// Domain is the registrar, and the host a placed call is addressed to (voiceless.aa.net.uk).
	Domain string
	// Proxy, when set, is where REGISTER and placed calls are sent instead of Domain (a test's peer).
	Proxy string
	// BindIP and Port are the local UDP address for SIP; media takes ports of its own on BindIP.
	BindIP string
	Port   int
	// ExternalHost and ExternalPort, when set, are the address put in Contact and SDP instead of
	// BindIP and Port: the NAT's public side (stun.go).
	ExternalHost string
	ExternalPort int
	// WatchAddress: every few minutes, check that the public address is still ExternalHost; when it
	// changed, serve ends (the parent starts it again, and it learns the new one).
	WatchAddress bool
	// Register: false only in tests, where nothing registers.
	Register bool
	Expiry   time.Duration
	// RingLimit is how long an announced call is left ringing for the parent before it is turned away.
	RingLimit time.Duration
	// AudioAfterAnswer is how long a call that is up may carry nothing from the line.
	AudioAfterAnswer time.Duration
	// SilentLine is how long the line may go quiet mid-call (no packets at all) before the call is
	// taken for dead: the line sends packets even when nobody speaks.
	SilentLine time.Duration
}

// liveCall is one call this process knows of: placed, or announced and perhaps answered.
type liveCall struct {
	id        string
	direction string // "out" or "in"
	voice     *voiceQueue
	accepted  atomic.Bool // the call is up: the person picked up, or this side did
	heard     atomic.Bool // a packet of audio came from the line
	rang      atomic.Bool // "ringing" was said (a placed call)
	ended     atomic.Bool
	over      sync.Once
	done      chan struct{} // closed when the call is over: its media loops stop
	lastHeard atomic.Int64  // unix ms of the newest packet from the line

	mu      sync.Mutex
	decided chan string        // an incoming call: "answer" or "reject"
	cancel  context.CancelFunc // a placed call that is still ringing: CANCEL it
	bye     func()             // a call that is up: BYE
}

type serveInput struct {
	Call   string `json:"call"`
	Ring   int    `json:"ring"`
	Answer string `json:"answer"`
	Reject string `json:"reject"`
	PCM    string `json:"pcm"`
	Last   bool   `json:"last"`
	Clear  bool   `json:"clear"`
	Hangup bool   `json:"hangup"`
}

// server is the process's state: the line, the call whose audio is carried, and the incoming calls
// that were announced and are still ringing.
type server struct {
	ctx  context.Context
	log  *zerolog.Logger
	conf lineConfig
	dg   *diago.Diago

	out  sync.Mutex
	emit func(event map[string]any)

	mu      sync.Mutex
	active  *liveCall
	ringing map[string]*liveCall

	ready      sync.Once
	registered chan struct{} // closed once the registration loop has unregistered (or never registered)
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// newServer sets the line up and starts listening; with conf.Register it registers and keeps the
// registration fresh until ctx ends. emit gets every event line.
func newServer(ctx context.Context, conf lineConfig, emit func(map[string]any)) (*server, error) {
	log := zerolog.Ctx(ctx)
	s := &server{ctx: ctx, log: log, conf: conf, ringing: map[string]*liveCall{}, registered: make(chan struct{})}
	s.emit = func(event map[string]any) {
		s.out.Lock()
		defer s.out.Unlock()
		emit(event)
	}
	ua, err := sipgo.NewUA(sipgo.WithUserAgent(conf.Number), sipgo.WithUserAgentHostname(conf.Domain))
	if err != nil {
		return nil, err
	}
	s.dg = diago.NewDiago(ua,
		diago.WithLogger(diagoLogger()),
		diago.WithTransport(diago.Transport{
			Transport:    "udp",
			BindHost:     conf.BindIP,
			BindPort:     conf.Port,
			ExternalHost: conf.ExternalHost,
			ExternalPort: conf.ExternalPort,
		}),
		diago.WithMediaConfig(diago.MediaConfig{Codecs: lineCodecs}),
	)
	if err := s.dg.ServeBackground(ctx, s.onInvite); err != nil {
		return nil, fmt.Errorf("listen on %s:%d: %w", conf.BindIP, conf.Port, err)
	}
	log.Info().Str("addr", net.JoinHostPort(conf.BindIP, fmt.Sprint(conf.Port))).Msg("listening for SIP")
	if conf.Register {
		go s.registerLoop()
	} else {
		close(s.registered)
		s.emit(map[string]any{"event": "ready", "self": conf.Number})
	}
	return s, nil
}

// registerLoop keeps the account registered: it registers, registers again at three quarters of
// the expiry it asks for (sooner than the registrar needs: a NAT forgets a quiet mapping), and,
// when ctx ends, unregisters this contact only (diago's own unregistration would remove every
// phone registered to the number). A registration that fails or lapses is tried again after a
// pause.
func (s *server) registerLoop() {
	defer close(s.registered)
	recipient := sip.Uri{Scheme: "sip", User: s.conf.Number, Host: s.conf.Domain}
	pause := 5 * time.Second
	for {
		t, err := s.dg.RegisterTransaction(s.ctx, recipient, diago.RegisterOptions{
			Username:  s.conf.Number,
			Password:  s.conf.Password,
			ProxyHost: s.conf.Proxy,
			Expiry:    s.conf.Expiry,
		})
		if err == nil {
			err = t.Register(s.ctx)
		}
		if err == nil {
			pause = 5 * time.Second
			s.log.Info().Str("registrar", s.conf.Domain).Str("contact", t.Origin.Contact().Address.String()).Msg("registered (200 OK to REGISTER)")
			s.ready.Do(func() { s.emit(map[string]any{"event": "ready", "self": s.conf.Number}) })
			err = s.keepRegistered(t)
			if s.ctx.Err() != nil {
				s.unregister(t)
				return
			}
		}
		if s.ctx.Err() != nil {
			return
		}
		s.log.Warn().Err(err).Dur("again_in", pause).Msg("registration failed or lapsed: registering again")
		select {
		case <-time.After(pause):
		case <-s.ctx.Done():
			return
		}
		pause = min(2*pause, 2*time.Minute)
	}
}

// keepRegistered registers again every three quarters of the expiry until ctx ends (nil) or a
// registration fails.
func (s *server) keepRegistered(t *diago.RegisterTransaction) error {
	tick := time.NewTicker(s.conf.Expiry * 3 / 4)
	defer tick.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return nil
		case <-tick.C:
		}
		if err := t.Qualify(s.ctx); err != nil {
			return err
		}
		s.log.Debug().Msg("registered again")
	}
}

// unregister removes this process's contact from the number: calls stop coming here at once.
func (s *server) unregister(t *diago.RegisterTransaction) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	t.Origin.RemoveHeader("Expires")
	expires := sip.ExpiresHeader(0)
	t.Origin.AppendHeader(&expires)
	if err := t.Qualify(ctx); err != nil {
		s.log.Warn().Err(err).Msg("unregistration failed: the registration lapses by itself")
		return
	}
	s.log.Info().Msg("unregistered")
}

// finish reports the call's end, once, and frees its place. A placed call that never rang ends
// as `failed`, which is what the parent waits for until it rings.
func (s *server) finish(lc *liveCall, reason string) {
	lc.over.Do(func() {
		lc.ended.Store(true)
		close(lc.done)
		s.mu.Lock()
		if s.active == lc {
			s.active = nil
		}
		delete(s.ringing, lc.id)
		s.mu.Unlock()
		s.log.Info().Str("call_id", lc.id).Str("direction", lc.direction).Str("reason", reason).Bool("answered", lc.accepted.Load()).Msg("call over")
		if lc.direction == "out" && !lc.rang.Load() {
			s.emit(map[string]any{"event": "failed", "reason": reason})
			return
		}
		s.emit(map[string]any{
			"event": "ended", "callId": lc.id, "reason": reason,
			"answered": lc.accepted.Load(), "stats": lc.voice.snapshot(),
		})
	})
}

// hangUp ends lc from this side, reporting the end under `reason` first.
func (s *server) hangUp(lc *liveCall, reason string) {
	s.finish(lc, reason)
	lc.mu.Lock()
	bye, cancel, decided := lc.bye, lc.cancel, lc.decided
	lc.mu.Unlock()
	switch {
	case bye != nil:
		bye()
	case cancel != nil:
		cancel()
	case decided != nil:
		select {
		case decided <- "reject":
		default:
		}
	}
}

// up marks lc as answered and carries its audio both ways until it is over.
func (s *server) up(lc *liveCall, med *diago.DialogMedia) error {
	writer, err := med.AudioWriter()
	if err != nil {
		return err
	}
	lc.accepted.Store(true)
	s.emit(map[string]any{"event": "answered", "callId": lc.id})
	go s.sendLoop(lc, writer)
	go s.receiveLoop(lc, med)
	go s.watch(lc)
	return nil
}

// watch ends lc when nothing came from the line soon after it was answered, or the line went
// silent mid-call.
func (s *server) watch(lc *liveCall) {
	answeredAt := time.Now()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-lc.done:
			return
		case <-tick.C:
		}
		if !lc.heard.Load() {
			if time.Since(answeredAt) > s.conf.AudioAfterAnswer {
				s.log.Warn().Str("call_id", lc.id).Msg("answered, but no audio came from the line: ending the call")
				s.hangUp(lc, noAudio)
				return
			}
			continue
		}
		if quiet := time.Since(time.UnixMilli(lc.lastHeard.Load())); quiet > s.conf.SilentLine {
			s.log.Warn().Str("call_id", lc.id).Dur("quiet", quiet).Msg("the line sent nothing: ending the call")
			s.hangUp(lc, fmt.Sprintf("the line went silent for %d s", int(quiet.Seconds())))
			return
		}
	}
}

// sendLoop plays the voice's queue to the line, one 20 ms packet every 20 ms, silence when there
// is nothing to say: a steady stream also keeps the NAT's mapping and the far end's jitter
// buffer open.
func (s *server) sendLoop(lc *liveCall, writer io.Writer) {
	down := newDownsampler()
	silence := make([]int16, voiceFrame)
	payload := make([]byte, lineFrameSamples)
	tick := time.NewTicker(frameMs * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-lc.done:
			return
		case <-tick.C:
		}
		frame := lc.voice.readFrame()
		if frame == nil {
			frame = silence
		}
		for i, sample := range down.process(frame) {
			payload[i] = alawEncode(sample)
		}
		if _, err := writer.Write(payload); err != nil {
			if !lc.ended.Load() {
				s.log.Warn().Err(err).Str("call_id", lc.id).Msg("audio to the line failed")
			}
			return
		}
	}
}

// receiveLoop turns the line's packets into `mic` lines of 60 ms at 16 kHz.
func (s *server) receiveLoop(lc *liveCall, med *diago.DialogMedia) {
	up := newUpsampler()
	reader := med.RTPPacketReader
	buf := make([]byte, media.RTPBufSize)
	decoded := make([]int16, 0, lineFrameSamples)
	pending := make([]int16, 0, 2*micFrameSamples)
	for {
		n, err := reader.Read(buf)
		if err != nil {
			if !lc.ended.Load() && !errors.Is(err, io.EOF) {
				s.log.Debug().Err(err).Str("call_id", lc.id).Msg("audio from the line stopped")
			}
			return
		}
		if lc.ended.Load() {
			return
		}
		if n == 0 {
			continue
		}
		if pt := reader.PacketHeader.PayloadType; pt != media.CodecAudioAlaw.PayloadType {
			s.log.Debug().Uint8("payload_type", pt).Str("call_id", lc.id).Msg("a packet that is not A-law (a key pressed?)")
			continue
		}
		lc.lastHeard.Store(time.Now().UnixMilli())
		if lc.heard.CompareAndSwap(false, true) {
			s.log.Info().Str("call_id", lc.id).Msg("audio is coming from the line")
		}
		lc.voice.heard()
		decoded = decoded[:0]
		for _, code := range buf[:n] {
			decoded = append(decoded, alawDecode(code))
		}
		pending = append(pending, up.process(decoded)...)
		for len(pending) >= micFrameSamples {
			pcm := make([]byte, 2*micFrameSamples)
			for i, sample := range pending[:micFrameSamples] {
				binary.LittleEndian.PutUint16(pcm[2*i:], uint16(sample))
			}
			pending = append(pending[:0], pending[micFrameSamples:]...)
			s.emit(map[string]any{"event": "mic", "pcm": base64.StdEncoding.EncodeToString(pcm)})
		}
	}
}

// onInvite is diago's handler for an incoming call: announced, left ringing until the parent says
// what to do, and held for as long as the call lasts (diago hangs up when it returns).
func (s *server) onInvite(d *diago.DialogServerSession) {
	from := d.InviteRequest.From()
	raw := d.FromUser()
	name := ""
	if from != nil {
		name = from.DisplayName
	}
	number, trusted := callerNumber(raw)
	if unescaped, err := url.PathUnescape(raw); err == nil {
		raw = unescaped
	}
	lc := &liveCall{id: newID(), direction: "in", voice: newVoiceQueue(), done: make(chan struct{}), decided: make(chan string, 1)}
	s.mu.Lock()
	s.ringing[lc.id] = lc
	s.mu.Unlock()
	s.log.Info().Str("call_id", lc.id).Str("from", raw).Str("name", name).Str("number", number).Bool("trusted", trusted).Msg("incoming call")
	if err := d.Ringing(); err != nil {
		s.log.Warn().Err(err).Msg("180 Ringing failed")
	}
	s.emit(map[string]any{
		"event": "incoming", "callId": lc.id, "number": number, "from": raw, "name": name,
		"untrusted": !trusted, "video": false, "group": false,
	})
	limit := time.NewTimer(s.conf.RingLimit)
	defer limit.Stop()
	select {
	case decision := <-lc.decided:
		if decision != "answer" {
			s.finish(lc, "turned away")
			return // diago answers 480 Temporarily Unavailable: the line's fallback takes the call
		}
	case <-d.Context().Done():
		s.finish(lc, "the caller hung up before it was answered")
		return
	case <-limit.C:
		s.finish(lc, "not answered in time")
		return
	case <-s.ctx.Done():
		s.finish(lc, "interrupted")
		return
	}
	med, err := d.Answer(diago.AnswerOptions{Codecs: lineCodecs})
	if err != nil {
		s.log.Warn().Err(err).Str("call_id", lc.id).Msg("answer failed")
		s.finish(lc, fmt.Sprintf("could not be answered: %v", err))
		return
	}
	lc.mu.Lock()
	lc.bye = func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := d.Hangup(ctx); err != nil {
			s.log.Warn().Err(err).Str("call_id", lc.id).Msg("BYE failed")
		}
	}
	lc.mu.Unlock()
	if lc.ended.Load() { // hung up while the answer was on its way
		lc.bye()
		return
	}
	if err := s.up(lc, med); err != nil {
		s.hangUp(lc, fmt.Sprintf("audio could not be set up: %v", err))
		return
	}
	s.holdUntilOver(lc, d.Context())
}

// holdUntilOver waits for the dialog to end (the person hung up, or this side's BYE went out),
// then makes sure the call is reported over.
func (s *server) holdUntilOver(lc *liveCall, dialog context.Context) {
	select {
	case <-dialog.Done():
	case <-lc.done:
		select { // this side hung up: give the BYE its time
		case <-dialog.Done():
		case <-time.After(6 * time.Second):
		}
	case <-s.ctx.Done():
		s.hangUp(lc, "interrupted")
	}
	s.finish(lc, "the person hung up")
}

// answer picks up an incoming call that was announced and is still ringing.
func (s *server) answer(callID string) {
	s.mu.Lock()
	lc := s.ringing[callID]
	busy := s.active != nil
	if lc != nil && !busy {
		delete(s.ringing, callID)
		s.active = lc
	}
	s.mu.Unlock()
	if lc == nil {
		s.emit(map[string]any{"event": "ended", "callId": callID, "reason": "the caller had already gone", "answered": false})
		return
	}
	if busy {
		s.log.Warn().Str("call_id", callID).Msg("not answered: another call is in progress")
		return
	}
	select {
	case lc.decided <- "answer":
	default:
	}
}

// reject turns away an incoming call that was announced and is still ringing.
func (s *server) reject(callID string) {
	s.mu.Lock()
	lc := s.ringing[callID]
	s.mu.Unlock()
	if lc == nil {
		return
	}
	select {
	case lc.decided <- "reject":
	default:
	}
}

// place rings target (E.164, "+44…"; or one of the line's own service codes, "*105") and gives up
// when nobody has answered after `ring`.
func (s *server) place(target string, ring time.Duration) {
	lc := &liveCall{id: newID(), direction: "out", voice: newVoiceQueue(), done: make(chan struct{})}
	s.mu.Lock()
	if s.active != nil {
		s.mu.Unlock()
		s.emit(map[string]any{"event": "failed", "reason": "a call is already in progress"})
		return
	}
	s.active = lc
	s.mu.Unlock()

	recipient := sip.Uri{Scheme: "sip", User: target, Host: s.conf.Domain}
	d, err := s.dg.NewDialog(recipient, diago.NewDialogOptions{})
	if err != nil {
		s.finish(lc, fmt.Sprintf("place call: %v", err))
		return
	}
	defer d.Close()
	if s.conf.Proxy != "" {
		d.InviteRequest.SetDestination(s.conf.Proxy)
	}
	ringing, cancel := context.WithCancel(s.ctx)
	defer cancel()
	lc.mu.Lock()
	lc.cancel = cancel
	lc.mu.Unlock()
	noAnswer := time.AfterFunc(ring, func() {
		if !lc.accepted.Load() {
			s.hangUp(lc, "no answer")
		}
	})
	defer noAnswer.Stop()
	rang := func() {
		if lc.rang.CompareAndSwap(false, true) {
			s.emit(map[string]any{"event": "ringing", "callId": lc.id})
		}
	}
	options := diago.InviteClientOptions{
		Username: s.conf.Number,
		Password: s.conf.Password,
		OnResponse: func(res *sip.Response) error {
			s.log.Debug().Int("status", res.StatusCode).Str("call_id", lc.id).Msg("placed call: response")
			if res.StatusCode == sip.StatusRinging || res.StatusCode == sip.StatusSessionInProgress {
				rang()
			}
			return nil
		},
	}
	options.WithCaller("", s.conf.Number, s.conf.Domain)
	s.log.Info().Str("call_id", lc.id).Str("to", target).Msg("placing call")
	med, err := d.Invite(ringing, options)
	if err != nil {
		s.finish(lc, inviteFailure(err))
		return
	}
	if err := d.Ack(s.ctx); err != nil {
		rang()
		s.finish(lc, fmt.Sprintf("the answer could not be acknowledged: %v", err))
		return
	}
	noAnswer.Stop()
	rang() // answered with no ring first: it still rang
	lc.mu.Lock()
	lc.cancel = nil
	lc.bye = func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := d.Hangup(ctx); err != nil {
			s.log.Warn().Err(err).Str("call_id", lc.id).Msg("BYE failed")
		}
	}
	lc.mu.Unlock()
	if lc.ended.Load() { // hung up while the answer was on its way
		lc.bye()
		return
	}
	if err := s.up(lc, med); err != nil {
		s.hangUp(lc, fmt.Sprintf("audio could not be set up: %v", err))
		return
	}
	s.holdUntilOver(lc, d.Context())
}

// inviteFailure says why a placed call did not connect.
func inviteFailure(err error) string {
	if res := refusal(err); res != nil {
		switch code := res.StatusCode; code {
		case 486, 600:
			return "busy"
		case 603:
			return "declined"
		case 480:
			return "unavailable"
		case 487:
			return "cancelled"
		case 404, 484:
			return "not a number that can be rung"
		case 401, 403, 407:
			return fmt.Sprintf("the line refused to place it (%d %s)", code, res.Reason)
		default:
			return fmt.Sprintf("%d %s", code, res.Reason)
		}
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	return fmt.Sprintf("place call: %v", err)
}

// refusal answers the final response a call was refused with, or nil.
func refusal(err error) *sip.Response {
	var pointer *sipgo.ErrDialogResponse
	if errors.As(err, &pointer) && pointer != nil {
		return pointer.Res
	}
	var value sipgo.ErrDialogResponse
	if errors.As(err, &value) {
		return value.Res
	}
	return nil
}

// callerNumber answers the caller's digits with the country code, and whether the line vouches
// for them. Andrews & Arnold give a caller as a UK national number (07…), in E.164 (+44…), or,
// when it is not trusted (a free call to sip:<number>@aa.org.uk from anywhere on the internet),
// with a "?" in front: such a caller says who they are and nothing checks it, so they get no
// number at all.
func callerNumber(raw string) (string, bool) {
	if unescaped, err := url.PathUnescape(raw); err == nil {
		raw = unescaped // the "?" arrives as %3f
	}
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.HasPrefix(raw, "?") || strings.EqualFold(raw, "anonymous") {
		return "", false
	}
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, raw)
	if len(digits) != len(strings.TrimPrefix(raw, "+")) {
		return "", false // not a phone number: letters or punctuation in it
	}
	switch {
	case strings.HasPrefix(raw, "+"):
	case strings.HasPrefix(digits, "00"):
		digits = digits[2:]
	case strings.HasPrefix(digits, "0"):
		digits = "44" + digits[1:]
	}
	if len(digits) < 8 {
		return "", false
	}
	return digits, true
}

// handle acts on one line of stdin.
func (s *server) handle(input serveInput) {
	if input.Call != "" {
		ring := 45
		if input.Ring > 0 {
			ring = input.Ring
		}
		go s.place(input.Call, time.Duration(ring)*time.Second)
		return
	}
	if input.Answer != "" {
		go s.answer(input.Answer)
		return
	}
	if input.Reject != "" {
		go s.reject(input.Reject)
		return
	}
	s.mu.Lock()
	lc := s.active
	s.mu.Unlock()
	if lc == nil {
		return
	}
	if input.Clear {
		lc.voice.clear()
	}
	if input.PCM != "" {
		if pcm, err := base64.StdEncoding.DecodeString(input.PCM); err == nil {
			lc.voice.push(pcm)
		}
	}
	if input.Last {
		lc.voice.last()
	}
	if input.Hangup {
		reason := "cancelled"
		if lc.accepted.Load() {
			reason = "hung up"
		}
		go s.hangUp(lc, reason)
	}
}

// close ends the call in progress and every ringing one, and waits (a few seconds at most) for the
// hang-up and the unregistration to go out.
func (s *server) close(reason string) {
	s.mu.Lock()
	calls := []*liveCall{}
	if s.active != nil {
		calls = append(calls, s.active)
	}
	for _, lc := range s.ringing {
		calls = append(calls, lc)
	}
	s.mu.Unlock()
	for _, lc := range calls {
		s.hangUp(lc, reason)
	}
}

func serve(ctx context.Context, conf lineConfig) error {
	log := zerolog.Ctx(ctx)
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	stdout := json.NewEncoder(os.Stdout)
	s, err := newServer(ctx, conf, func(event map[string]any) { _ = stdout.Encode(event) })
	if err != nil {
		return err
	}
	lines := bufio.NewScanner(os.Stdin)
	lines.Buffer(make([]byte, 1<<20), 8<<20)
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		for lines.Scan() {
			var input serveInput
			if err := json.Unmarshal(lines.Bytes(), &input); err != nil {
				log.Warn().Err(err).Msg("a line on stdin is not JSON")
				continue
			}
			s.handle(input)
		}
	}()
	moved := make(chan string, 1)
	if conf.WatchAddress && conf.ExternalHost != "" {
		go s.watchAddress(moved)
	}
	var result error
	select {
	case <-closed:
	case <-ctx.Done():
	case address := <-moved:
		result = fmt.Errorf("the public address changed from %s to %s: start again to learn it", conf.ExternalHost, address)
	}
	s.close("interrupted")
	time.Sleep(500 * time.Millisecond) // the BYE's transaction
	stop()
	select { // the unregistration
	case <-s.registered:
	case <-time.After(6 * time.Second):
	}
	return result
}

// watchAddress says on moved when the public address is no longer conf.ExternalHost, between
// calls: the Contact and SDP this process gives out would be wrong from then on.
func (s *server) watchAddress(moved chan<- string) {
	tick := time.NewTicker(5 * time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-tick.C:
		}
		address, _, err := publicAddress(s.conf.BindIP, 0)
		if err != nil {
			s.log.Warn().Err(err).Msg("could not check the public address")
			continue
		}
		s.mu.Lock()
		busy := s.active != nil || len(s.ringing) > 0
		s.mu.Unlock()
		if address != s.conf.ExternalHost && !busy {
			s.log.Warn().Str("was", s.conf.ExternalHost).Str("now", address).Msg("the public address changed")
			moved <- address
			return
		}
	}
}

// diagoLogger is the SIP stack's own log: warnings by default, everything with LOG_LEVEL=debug.
func diagoLogger() *slog.Logger {
	level := slog.LevelWarn
	if strings.EqualFold(os.Getenv("LOG_LEVEL"), "debug") {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	media.SetDefaultLogger(logger)
	return logger
}
