// jeeves-phone — real phone calls on an Andrews & Arnold VoIP number, for an iterate project's
// voice agent: the number registered as a SIP phone, its calls carried as the WhatsApp bridge
// carries WhatsApp's (whatsapp-calls/serve.go), so one lend's code drives either.
//
//	jeeves-phone serve                       stay registered: place calls and be rung, with the
//	                                         calls' audio over stdin and stdout (serve.go): what
//	                                         calls.ts drives
//	jeeves-phone dial <sip-uri> <play.wav> <record.wav> [seconds]
//	                                         a test caller with no account: rings the URI (for
//	                                         sip:+44…@aa.org.uk, Andrews & Arnold's free route into
//	                                         a number from the internet), plays the file once
//	                                         answered (8 kHz mono PCM16, after
//	                                         PHONE_DIAL_PLAY_AFTER seconds, 6 by default), records
//	                                         what comes back, and hangs up after `seconds` (40)
//
// serve reads its account from the environment:
//
//	PHONE_SIP_NUMBER         the number in E.164, the registration's username (+447441138737)
//	PHONE_SIP_PASSWORD_FILE  a file holding the number's SIP password (never the password itself)
//	PHONE_SIP_DOMAIN         the registrar, voiceless.aa.net.uk unless set
//	PHONE_SIP_PORT           the local UDP port for SIP, 5062 unless set
//	PHONE_SIP_BIND           the local address, the one with the route to the registrar unless set
//	PHONE_SIP_EXTERNAL_HOST  the public address to put in Contact and SDP; unset, it is asked of
//	                         stun.aa.net.uk (stun.go), and checked every five minutes
//	PHONE_SIP_STUN           "0": no STUN, the local address in Contact and SDP (no NAT)
//	PHONE_SIP_EXPIRY         seconds a registration lasts, 300 unless set
//	PHONE_SIP_TRACE          "1" (the default) logs every SIP message's first line, "full" whole
//	                         messages with the Authorization headers taken out, "0" nothing
//	LOG_LEVEL                debug for the SIP stack's own log as well
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/emiago/sipgo/sip"
	"github.com/rs/zerolog"
)

func main() {
	level := zerolog.InfoLevel
	if parsed, err := zerolog.ParseLevel(os.Getenv("LOG_LEVEL")); err == nil && parsed != zerolog.NoLevel {
		level = parsed
	}
	zerolog.TimeFieldFormat = time.RFC3339Nano
	terminal := false
	if info, err := os.Stderr.Stat(); err == nil {
		terminal = info.Mode()&os.ModeCharDevice != 0
	}
	logger := zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: "15:04:05.000", NoColor: !terminal}).Level(level).With().Timestamp().Logger()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx = logger.WithContext(ctx)

	if len(os.Args) < 2 {
		usage()
	}
	traceSIP(&logger, os.Getenv("PHONE_SIP_TRACE"))
	var err error
	switch os.Args[1] {
	case "serve":
		var conf lineConfig
		if conf, err = lineConfigFromEnv(); err == nil {
			err = serve(ctx, conf)
		}
	case "dial":
		if len(os.Args) < 5 {
			usage()
		}
		seconds := 40
		if len(os.Args) > 5 {
			if seconds, err = strconv.Atoi(os.Args[5]); err != nil {
				usage()
			}
		}
		err = dial(ctx, os.Args[2], os.Args[3], os.Args[4], time.Duration(seconds)*time.Second)
	default:
		usage()
	}
	if err != nil {
		logger.Fatal().Err(err).Msg("failed")
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: jeeves-phone serve | dial <sip-uri> <play.wav> <record.wav> [seconds]")
	os.Exit(2)
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func lineConfigFromEnv() (lineConfig, error) {
	conf := lineConfig{
		Number:           os.Getenv("PHONE_SIP_NUMBER"),
		Domain:           envOr("PHONE_SIP_DOMAIN", "voiceless.aa.net.uk"),
		BindIP:           os.Getenv("PHONE_SIP_BIND"),
		ExternalHost:     os.Getenv("PHONE_SIP_EXTERNAL_HOST"),
		Register:         true,
		RingLimit:        60 * time.Second,
		AudioAfterAnswer: 6 * time.Second,
		SilentLine:       20 * time.Second,
	}
	if !strings.HasPrefix(conf.Number, "+") {
		return conf, errors.New("PHONE_SIP_NUMBER must be the number in E.164, +44…")
	}
	file := os.Getenv("PHONE_SIP_PASSWORD_FILE")
	if file == "" {
		return conf, errors.New("PHONE_SIP_PASSWORD_FILE must name the file holding the SIP password")
	}
	password, err := os.ReadFile(file)
	if err != nil {
		return conf, fmt.Errorf("read the SIP password: %w", err)
	}
	conf.Password = strings.TrimSpace(string(password))
	if conf.Port, err = strconv.Atoi(envOr("PHONE_SIP_PORT", "5062")); err != nil {
		return conf, fmt.Errorf("PHONE_SIP_PORT: %w", err)
	}
	expiry, err := strconv.Atoi(envOr("PHONE_SIP_EXPIRY", "300"))
	if err != nil {
		return conf, fmt.Errorf("PHONE_SIP_EXPIRY: %w", err)
	}
	conf.Expiry = time.Duration(expiry) * time.Second
	if conf.BindIP == "" {
		if conf.BindIP, err = localAddressTowards(conf.Domain); err != nil {
			return conf, err
		}
	}
	if conf.ExternalHost == "" && os.Getenv("PHONE_SIP_STUN") != "0" {
		if conf.ExternalHost, conf.ExternalPort, err = publicAddress(conf.BindIP, conf.Port); err != nil {
			return conf, fmt.Errorf("find the public address: %w", err)
		}
		conf.WatchAddress = true
	}
	return conf, nil
}

// localAddressTowards answers this computer's address on the route to host (nothing is sent).
func localAddressTowards(host string) (string, error) {
	conn, err := net.Dial("udp4", net.JoinHostPort(host, "5060"))
	if err != nil {
		return "", fmt.Errorf("find the local address towards %s: %w", host, err)
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP.String(), nil
}

// sipTrace logs SIP messages as they go out and come in: the first line, the CSeq and the peer,
// or (full) the whole message without its Authorization headers. The password itself never
// travels: digest auth sends a hash of it.
type sipTrace struct {
	log  *zerolog.Logger
	full bool
}

func traceSIP(log *zerolog.Logger, mode string) {
	if mode == "0" {
		return
	}
	sip.SIPDebug = true
	sip.SIPDebugTracer(sipTrace{log: log, full: mode == "full"})
}

func (t sipTrace) SIPTraceRead(_, _, raddr string, msg []byte)  { t.trace("<-", raddr, msg) }
func (t sipTrace) SIPTraceWrite(_, _, raddr string, msg []byte) { t.trace("->", raddr, msg) }

func (t sipTrace) trace(direction, peer string, msg []byte) {
	lines := strings.Split(string(msg), "\r\n")
	if strings.TrimSpace(lines[0]) == "" {
		return // a keepalive
	}
	header := func(name string) string {
		for _, line := range lines[1:] {
			if line == "" {
				break
			}
			if key, value, ok := strings.Cut(line, ":"); ok && strings.EqualFold(strings.TrimSpace(key), name) {
				return strings.TrimSpace(value)
			}
		}
		return ""
	}
	event := t.log.Info().Str("sip", direction).Str("peer", peer).Str("cseq", header("CSeq"))
	if t.full {
		kept := make([]string, 0, len(lines))
		for _, line := range lines {
			lower := strings.ToLower(line)
			if strings.HasPrefix(lower, "authorization:") || strings.HasPrefix(lower, "proxy-authorization:") {
				kept = append(kept, line[:strings.Index(line, ":")+1]+" (taken out of the log)")
				continue
			}
			kept = append(kept, line)
		}
		event.Msg(strings.Join(kept, "\n"))
		return
	}
	if strings.HasPrefix(lines[0], "INVITE ") || strings.HasPrefix(lines[0], "SIP/2.0") {
		event = event.Str("from", header("From"))
	}
	event.Msg(lines[0])
}
