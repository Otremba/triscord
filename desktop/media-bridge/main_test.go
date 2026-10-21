package main

import (
	"bytes"
	"encoding/json"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4/pkg/media/samplebuilder"
	"testing"
	"time"
)

func TestEncodedH264SurvivesFragmentationAndReordering(t *testing.T) {
	frame := append([]byte{0, 0, 0, 1, 0x65}, bytes.Repeat([]byte{0x12}, 8000)...)
	pay := &codecs.H264Payloader{}
	payloads := pay.Payload(1200, frame)
	if len(payloads) < 3 {
		t.Fatal("test did not fragment the IDR")
	}
	sb := samplebuilder.New(512, &codecs.H264Packet{}, 90000)
	packets := make([]*rtp.Packet, len(payloads))
	for i, payload := range payloads {
		packets[i] = &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(100 + i), Timestamp: 90000, Marker: i == len(payloads)-1}, Payload: payload}
	}
	sb.Push(packets[0])
	for i := len(packets) - 1; i >= 1; i-- {
		sb.Push(packets[i])
	}
	sb.Push(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(100 + len(payloads)), Timestamp: 93000, Marker: true}, Payload: []byte{0x41, 1}})
	sample := sb.Pop()
	if sample == nil || !bytes.Equal(sample.Data, frame) || sample.PacketTimestamp != 90000 || !h264Key(sample.Data) {
		t.Fatal("encoded frame or timestamp changed")
	}
}
func TestOutputQueueBoundsBytesAndPackets(t *testing.T) {
	b := &bridge{output: make(chan message, 96)}
	frame := message{Event: "video", Data: make([]byte, 2*1024*1024)}
	for i := 0; i < 4; i++ {
		if !b.emit(frame) {
			t.Fatal("queue refused its budget")
		}
	}
	if b.emit(frame) || b.queuedBytes.Load() != 8*1024*1024 {
		t.Fatal("queue exceeded byte budget")
	}
	b = &bridge{output: make(chan message, 1)}
	if !b.emit(message{Event: "audio", Data: []byte{1}}) || b.emit(message{Event: "audio", Data: []byte{2}}) || b.queuedBytes.Load() != 1 {
		t.Fatal("packet bound/accounting failed")
	}
}
func TestKeysIdentityAndPipeMessages(t *testing.T) {
	if peerID("socket/screen") != "socket" || h264Key([]byte{0, 0, 1, 0x41}) || !h264Key([]byte{0, 0, 1, 0x65}) {
		t.Fatal("key/identity classification")
	}
	source := message{Event: "audio", Peer: "socket", Timestamp: 0xfffffff0, Data: []byte{0, 1, 255}, Duration: 20000}
	wire, _ := json.Marshal(source)
	var dest message
	if json.Unmarshal(wire, &dest) != nil || !bytes.Equal(source.Data, dest.Data) || dest.Timestamp != source.Timestamp {
		t.Fatal("pipe corrupted packet")
	}
	// A malformed command must terminate without dialing any endpoint or touching devices.
	done := make(chan struct{})
	go func() { run(bytes.NewBufferString("{bad json}\n"), &bytes.Buffer{}); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("malformed command hung")
	}
}
