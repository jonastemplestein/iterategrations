// dial.go — a test caller with no account: `jeeves-phone dial <sip-uri> <play.wav> <record.wav>`.
// It is how the line is tested without ringing anyone: Andrews & Arnold put a call to
// sip:<number>@aa.org.uk through to the number like any incoming call, free (the caller ID marked
// untrusted), so this rings the bridge from the internet the way a phone would. It never
// authenticates, so it can never place a call that costs anything.
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"time"

	"github.com/emiago/diago"
	"github.com/emiago/diago/media"
	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/rs/zerolog"
)

func dial(ctx context.Context, target, playFile, recordFile string, length time.Duration) error {
	log := zerolog.Ctx(ctx)
	var recipient sip.Uri
	if err := sip.ParseUri(target, &recipient); err != nil {
		return fmt.Errorf("parse %q: %w", target, err)
	}
	play, rate, err := readWAV(playFile)
	if err != nil {
		return err
	}
	if rate != lineRate {
		return fmt.Errorf("%s is %d Hz: want 8000 Hz mono PCM16", playFile, rate)
	}
	playAfter := 6 * time.Second
	if seconds, err := strconv.ParseFloat(os.Getenv("PHONE_DIAL_PLAY_AFTER"), 64); err == nil {
		playAfter = time.Duration(seconds * float64(time.Second))
	}

	// the host's SIP servers, as a phone finds them (aa.org.uk only has SRV records)
	destination := net.JoinHostPort(recipient.Host, "5060")
	if recipient.Port != 0 {
		destination = net.JoinHostPort(recipient.Host, strconv.Itoa(recipient.Port))
	} else if _, records, err := net.LookupSRV("sip", "udp", recipient.Host); err == nil && len(records) > 0 {
		destination = net.JoinHostPort(records[0].Target, strconv.Itoa(int(records[0].Port)))
	}
	destinationHost, _, _ := net.SplitHostPort(destination)
	bind := envOr("PHONE_DIAL_BIND", "")
	if bind == "" {
		if bind, err = localAddressTowards(destinationHost); err != nil {
			return err
		}
	}
	port, _ := strconv.Atoi(envOr("PHONE_DIAL_PORT", "5072"))
	// the public address in Contact and SDP, or the line's audio never reaches this caller
	publicIP, publicPort, err := publicAddress(bind, port)
	if err != nil {
		return fmt.Errorf("find the public address: %w", err)
	}
	ua, err := sipgo.NewUA(sipgo.WithUserAgent(envOr("PHONE_DIAL_FROM", "phonetest")), sipgo.WithUserAgentHostname(bind))
	if err != nil {
		return err
	}
	defer ua.Close()
	dg := diago.NewDiago(ua,
		diago.WithLogger(diagoLogger()),
		diago.WithTransport(diago.Transport{Transport: "udp", BindHost: bind, BindPort: port, ExternalHost: publicIP, ExternalPort: publicPort}),
		diago.WithMediaConfig(diago.MediaConfig{Codecs: lineCodecs}),
	)
	if err := dg.ServeBackground(ctx, func(d *diago.DialogServerSession) {}); err != nil {
		return err
	}
	d, err := dg.NewDialog(recipient, diago.NewDialogOptions{})
	if err != nil {
		return err
	}
	defer d.Close()
	d.InviteRequest.SetDestination(destination)
	log.Info().Str("to", recipient.String()).Str("via", destination).Msg("dialling")
	ringing, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	med, err := d.Invite(ringing, diago.InviteClientOptions{
		OnResponse: func(res *sip.Response) error {
			log.Info().Int("status", res.StatusCode).Str("reason", res.Reason).Msg("dial: response")
			return nil
		},
	})
	if err != nil {
		return fmt.Errorf("the call was not answered: %w", err)
	}
	if err := d.Ack(ctx); err != nil {
		return err
	}
	answeredAt := time.Now()
	log.Info().Msg("answered: recording")
	writer, err := med.AudioWriter()
	if err != nil {
		return err
	}
	done := make(chan struct{})
	heard := make(chan []int16, 1)
	go func() { // what comes back, until the call ends
		var recorded []int16
		defer func() { heard <- recorded }()
		buf := make([]byte, media.RTPBufSize)
		for {
			n, err := med.RTPPacketReader.Read(buf)
			if err != nil {
				return
			}
			if med.RTPPacketReader.PacketHeader.PayloadType != media.CodecAudioAlaw.PayloadType {
				continue
			}
			for _, code := range buf[:n] {
				recorded = append(recorded, alawDecode(code))
			}
			select {
			case <-done:
				return
			default:
			}
		}
	}()
	go func() { // silence, then the file, then silence, one packet every 20 ms
		tick := time.NewTicker(frameMs * time.Millisecond)
		defer tick.Stop()
		payload := make([]byte, lineFrameSamples)
		at := 0
		for {
			select {
			case <-done:
				return
			case <-tick.C:
			}
			for i := range payload {
				payload[i] = alawSilence
				if time.Since(answeredAt) >= playAfter && at < len(play) {
					payload[i] = alawEncode(play[at])
					at++
				}
			}
			if _, err := writer.Write(payload); err != nil {
				return
			}
		}
	}()
	select {
	case <-time.After(length):
		log.Info().Msg("hanging up")
		hangup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := d.Hangup(hangup); err != nil {
			log.Warn().Err(err).Msg("BYE failed")
		}
	case <-d.Context().Done():
		log.Info().Msg("the far end hung up")
	case <-ctx.Done():
	}
	close(done)
	_ = med.Close()
	var recorded []int16
	select {
	case recorded = <-heard:
	case <-time.After(2 * time.Second):
		return errors.New("the recording did not stop")
	}
	if err := writeWAV(recordFile, recorded, lineRate); err != nil {
		return err
	}
	fmt.Printf("{\"answered\":true,\"seconds\":%.1f,\"recording\":%q,\"recordedSeconds\":%.1f}\n",
		time.Since(answeredAt).Seconds(), recordFile, float64(len(recorded))/lineRate)
	return nil
}
