// Triscord's encoded-media adapter. It never opens a capture/playback device.
// JSON lines travel over anonymous parent/child pipes; credentials never enter arguments or files.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/rtcp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/samplebuilder"
)

type message struct {
	Command   string `json:"command,omitempty"`
	Event     string `json:"event,omitempty"`
	URL       string `json:"url,omitempty"`
	Token     string `json:"token,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Peer      string `json:"peer,omitempty"`
	Track     string `json:"track,omitempty"`
	Data      []byte `json:"data,omitempty"`
	Timestamp uint32 `json:"timestamp,omitempty"`
	Duration  int64  `json:"duration,omitempty"` // microseconds
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
	FPS       int    `json:"fps,omitempty"`
	Bitrate   int    `json:"bitrate,omitempty"`
	Key       bool   `json:"key,omitempty"`
	Disabled  bool   `json:"disabled,omitempty"`
}
type bridge struct {
	room         *lksdk.Room
	kind         string
	tracks       map[string]*lksdk.LocalTrack
	publications map[string]*lksdk.LocalTrackPublication
	remote       sync.Map
	disabled     sync.Map
	output       chan message
	control      chan message
	queuedBytes  atomic.Int64
}

func (b *bridge) emit(m message) bool {
	if m.Event != "audio" && m.Event != "video" {
		select {
		case b.control <- m:
			return true
		default:
			return false
		}
	}
	if len(m.Data) > 4*1024*1024 {
		return false
	}
	if b.queuedBytes.Add(int64(len(m.Data))) > 8*1024*1024 {
		b.queuedBytes.Add(-int64(len(m.Data)))
		return false
	}
	select {
	case b.output <- m:
		return true
	default: /* Never accumulate stale media behind a slow renderer. */
		b.queuedBytes.Add(-int64(len(m.Data)))
		return false
	}
}
func (b *bridge) start(m message) error {
	b.kind = m.Kind
	cb := lksdk.NewRoomCallback()
	cb.OnDisconnected = func() { b.emit(message{Event: "disconnected"}) }
	cb.OnReconnecting = func() { b.emit(message{Event: "reconnecting"}) }
	cb.OnReconnected = func() { b.emit(message{Event: "connected"}); b.emit(message{Event: "keyframe"}) }
	cb.OnTrackPublished = func(pub *lksdk.RemoteTrackPublication, p *lksdk.RemoteParticipant) {
		b.remote.Store(peerID(p.Identity())+"/"+pub.SID(), pub)
		_, disabled := b.disabled.Load(peerID(p.Identity()))
		if pub.Kind() != lksdk.TrackKindVideo || !disabled {
			_ = pub.SetSubscribed(true)
		}
	}
	cb.OnTrackSubscribed = func(t *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, p *lksdk.RemoteParticipant) {
		b.remote.Store(peerID(p.Identity())+"/"+pub.SID(), pub)
		if _, disabled := b.disabled.Load(peerID(p.Identity())); disabled && t.Kind() == webrtc.RTPCodecTypeVideo {
			_ = pub.SetSubscribed(false)
			return
		}
		go b.receive(t, pub, peerID(p.Identity()), p)
	}
	cb.OnTrackUnpublished = func(pub *lksdk.RemoteTrackPublication, p *lksdk.RemoteParticipant) {
		b.remote.Delete(peerID(p.Identity()) + "/" + pub.SID())
	}
	room, err := lksdk.ConnectToRoomWithToken(m.URL, m.Token, cb, lksdk.WithAutoSubscribe(false), lksdk.WithConnectTimeout(15*time.Second), lksdk.WithRetransmitBufferSize(2048))
	if err != nil {
		return err
	}
	b.room = room
	// Published tracks may precede callback installation/initial connection completion.
	for _, p := range room.GetRemoteParticipants() {
		for _, pub := range p.TrackPublications() {
			if r, ok := pub.(*lksdk.RemoteTrackPublication); ok {
				b.remote.Store(peerID(p.Identity())+"/"+pub.SID(), r)
				_ = r.SetSubscribed(true)
			}
		}
	}
	b.emit(message{Event: "connected"})
	return nil
}
func peerID(identity string) string { return strings.SplitN(identity, "/", 2)[0] }
func (b *bridge) publish(m message) error {
	b.unpublish()
	if b.kind == "voice" || b.kind == "screen" {
		source := livekit.TrackSource_MICROPHONE
		if b.kind == "screen" {
			source = livekit.TrackSource_SCREEN_SHARE_AUDIO
		}
		if err := b.track("audio", webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1;stereo=1"}, source, m); err != nil {
			return err
		}
	}
	if b.kind != "voice" {
		source := livekit.TrackSource_SCREEN_SHARE
		if b.kind == "camera" {
			source = livekit.TrackSource_CAMERA
		}
		return b.track("video", webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e033", RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}, {Type: "goog-remb"}}}, source, m)
	}
	return nil
}
func (b *bridge) track(kind string, codec webrtc.RTPCodecCapability, source livekit.TrackSource, m message) error {
	track, err := lksdk.NewLocalTrack(codec, lksdk.WithRTCPHandler(func(p rtcp.Packet) {
		switch v := p.(type) {
		case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
			b.emit(message{Event: "keyframe"})
		case *rtcp.ReceiverEstimatedMaximumBitrate:
			b.emit(message{Event: "bitrate", Bitrate: int(v.Bitrate)})
		}
	}))
	if err != nil {
		return err
	}
	name := fmt.Sprintf("%s:%d:%d:%d:%d", kind, m.Width, m.Height, m.FPS, m.Bitrate)
	pub, err := b.room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: name, Source: source, Stereo: true, VideoWidth: m.Width, VideoHeight: m.Height})
	if err != nil {
		_ = track.Close()
		return err
	}
	b.tracks[kind] = track
	b.publications[kind] = pub
	b.emit(message{Event: "keyframe"})
	return nil
}
func (b *bridge) unpublish() {
	for kind, pub := range b.publications {
		if b.room != nil {
			_ = b.room.LocalParticipant.UnpublishTrack(pub.SID())
		}
		_ = b.tracks[kind].Close()
	}
	b.tracks = map[string]*lksdk.LocalTrack{}
	b.publications = map[string]*lksdk.LocalTrackPublication{}
}
func (b *bridge) receive(t *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, peer string, p *lksdk.RemoteParticipant) {
	video := t.Kind() == webrtc.RTPCodecTypeVideo
	if video && !strings.EqualFold(t.Codec().MimeType, webrtc.MimeTypeH264) {
		return
	}
	if !video && !strings.EqualFold(t.Codec().MimeType, webrtc.MimeTypeOpus) {
		return
	}
	cfg := message{Event: "video", Peer: peer, Track: pub.SID(), FPS: 30, Bitrate: 8000000}
	info := pub.TrackInfo()
	if info != nil {
		cfg.Width = int(info.Width)
		cfg.Height = int(info.Height)
	}
	parts := strings.Split(pub.Name(), ":")
	if len(parts) == 5 {
		cfg.FPS, _ = strconv.Atoi(parts[3])
		cfg.Bitrate, _ = strconv.Atoi(parts[4])
	}
	// samplebuilder reorders RTP before depacketization; missing video frames request a fresh IDR.
	sb := samplebuilder.New(512, &codecs.H264Packet{}, 90000, samplebuilder.WithMaxTimeDelay(500*time.Millisecond))
	needKey := true
	lastPLI := time.Time{}
	pli := func() {
		if time.Since(lastPLI) > time.Second {
			p.WritePLI(t.SSRC())
			lastPLI = time.Now()
		}
	}
	if video {
		pli()
	}
	for {
		packet, _, err := t.ReadRTP()
		if err != nil {
			return
		}
		if _, disabled := b.disabled.Load(peer); disabled && video {
			continue
		}
		if !video {
			b.emit(message{Event: "audio", Peer: peer, Track: pub.SID(), Timestamp: packet.Timestamp, Data: packet.Payload})
			continue
		}
		sb.Push(packet)
		for {
			sample := sb.Pop()
			if sample == nil {
				break
			}
			if sample.PrevDroppedPackets > 0 {
				needKey = true
				pli()
				continue
			}
			out := cfg
			out.Data = sample.Data
			out.Timestamp = sample.PacketTimestamp
			out.Key = h264Key(sample.Data)
			if needKey && !out.Key {
				pli()
				continue
			}
			needKey = false
			if !b.emit(out) {
				needKey = true
				pli()
			}
		}
	}
}
func h264Key(data []byte) bool {
	for i := 0; i+3 < len(data); i++ {
		if data[i] == 0 && data[i+1] == 0 && data[i+2] == 1 && data[i+3]&31 == 5 {
			return true
		}
	}
	return false
}
func (b *bridge) subscription(peer string, disabled bool) {
	if disabled {
		b.disabled.Store(peer, true)
	} else {
		b.disabled.Delete(peer)
	}
	b.remote.Range(func(k, v any) bool {
		if pub := v.(*lksdk.RemoteTrackPublication); strings.HasPrefix(k.(string), peer+"/") && pub.Kind() == lksdk.TrackKindVideo {
			_ = pub.SetSubscribed(!disabled)
		}
		return true
	})
	if !disabled {
		b.keyframe(peer)
	}
}
func (b *bridge) keyframe(peer string) {
	if b.room == nil {
		return
	}
	for _, p := range b.room.GetRemoteParticipants() {
		if peerID(p.Identity()) != peer {
			continue
		}
		for _, pub := range p.TrackPublications() {
			if r, ok := pub.(*lksdk.RemoteTrackPublication); ok {
				if t := r.TrackRemote(); t != nil && t.Kind() == webrtc.RTPCodecTypeVideo {
					p.WritePLI(t.SSRC())
				}
			}
		}
	}
}
func run(input io.Reader, output io.Writer) {
	b := &bridge{output: make(chan message, 96), control: make(chan message, 16), tracks: map[string]*lksdk.LocalTrack{}, publications: map[string]*lksdk.LocalTrackPublication{}}
	done := make(chan struct{})
	defer close(done)
	go func() {
		enc := json.NewEncoder(output)
		for {
			var m message
			select {
			case m = <-b.control:
			default:
				select {
				case m = <-b.control:
				case m = <-b.output:
				case <-done:
					return
				}
			}
			b.queuedBytes.Add(-int64(len(m.Data)))
			if enc.Encode(m) != nil {
				os.Exit(0)
			}
		}
	}()
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 16*1024*1024)
	for scanner.Scan() {
		var m message
		if json.Unmarshal(scanner.Bytes(), &m) != nil {
			break
		}
		var err error
		switch m.Command {
		case "connect":
			if b.room != nil {
				return
			}
			if m.Kind != "voice" && m.Kind != "screen" && m.Kind != "camera" {
				return
			}
			err = b.start(m)
		case "publish":
			if b.room != nil {
				err = b.publish(m)
			}
		case "unpublish":
			b.unpublish()
		case "audio", "video":
			if t := b.tracks[m.Command]; t != nil && len(m.Data) > 0 && len(m.Data) <= 8*1024*1024 && m.Duration > 0 && m.Duration <= 1000000 {
				err = t.WriteSample(media.Sample{Data: m.Data, Duration: time.Duration(m.Duration) * time.Microsecond, PacketTimestamp: m.Timestamp}, nil)
			}
		case "subscription":
			b.subscription(m.Peer, m.Disabled)
		case "keyframe":
			b.keyframe(m.Peer)
		default:
			return
		}
		if err != nil {
			b.emit(message{Event: "error"})
		} // Provider errors may contain credentials: never forward them.
	}
	b.unpublish()
	if b.room != nil {
		b.room.Disconnect()
	}
}
func main() { run(os.Stdin, os.Stdout) }
