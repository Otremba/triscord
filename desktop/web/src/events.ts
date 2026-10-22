// Typed names and payloads for the page's global DOM events (tri-*). The mechanism stays the same
// (dispatchEvent / addEventListener); this module only centralizes the string names and payload types
// so a rename or a payload change is caught by the type checker instead of silently breaking a listener.
import type { ChatMessage } from './protocol';

export type OpenModalDetail =
    | { kind: 'createChannel'; categoryName: string }
    | { kind: 'deleteChannel'; channelId: string; channelName: string }
    | { kind: 'invite'; serverId: string; serverName: string }
    | { kind: 'deleteMessage'; message: ChatMessage }
    | { kind: 'deleteServer' | 'leaveServer'; serverId: string; serverName: string }
    | { kind: 'shareScreen' };

export const EVENTS = {
    openServerModal: 'tri-open-server-modal',
    openQuickSwitcher: 'tri-open-quick-switcher',
    openCameraPreview: 'tri-open-camera-preview',
    openProfile: 'tri-open-profile',
    toggleSidebar: 'tri-toggle-sidebar',
    openSettings: 'tri-open-settings',
    openModal: 'tri-open-modal',
    openChat: 'tri-open-chat',
    chatRateLimited: 'tri-chat-rate-limited',
    callActivity: 'tri-call-activity',
    layoutChanged: 'tri-layout-changed',
    overlaysChanged: 'tri-overlays-changed',
    previewNotice: 'tri-preview-notice',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export function emit(name: EventName, detail?: unknown): void {
    dispatchEvent(detail === undefined ? new Event(name) : new CustomEvent(name, { detail }));
}

export function on(name: EventName, handler: (event: Event) => void): () => void {
    addEventListener(name, handler);
    return () => removeEventListener(name, handler);
}