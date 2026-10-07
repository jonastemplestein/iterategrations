// stun.go — the address the internet sees this computer at. Behind a NAT the line must be told
// the public address, in Contact and in SDP: Andrews & Arnold send a call's ACK to the Contact
// of the answer and its audio to the SDP's address, and a private address in either loses them
// (seen 2026-10-06: an answer with Contact 192.168.0.63 was never acknowledged; a test caller
// whose SDP said 192.168.0.63 heard nothing). The STUN server is theirs, stun.aa.net.uk.
package main

import (
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/pion/stun/v3"
)

const stunServer = "stun.aa.net.uk:3478"

// publicAddress asks the STUN server what address a packet from local (ip:port, port 0 for any)
// arrives from: the NAT's public address and port for it.
func publicAddress(localIP string, localPort int) (string, int, error) {
	server, err := net.ResolveUDPAddr("udp4", stunServer)
	if err != nil {
		return "", 0, err
	}
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP(localIP), Port: localPort})
	if err != nil {
		return "", 0, err
	}
	defer conn.Close()
	buf := make([]byte, 1500)
	for attempt := 0; attempt < 3; attempt++ {
		request := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
		if _, err := conn.WriteTo(request.Raw, server); err != nil {
			return "", 0, err
		}
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		n, _, err := conn.ReadFrom(buf)
		if err != nil {
			continue
		}
		response := &stun.Message{Raw: append([]byte(nil), buf[:n]...)}
		if err := response.Decode(); err != nil || response.TransactionID != request.TransactionID {
			continue
		}
		var mapped stun.XORMappedAddress
		if err := mapped.GetFrom(response); err != nil {
			return "", 0, fmt.Errorf("STUN answer without an address: %w", err)
		}
		return mapped.IP.String(), mapped.Port, nil
	}
	return "", 0, errors.New("no answer from " + stunServer)
}
