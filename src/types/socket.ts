export interface ChatMessage {
  id: string;
  roomId: string;
  sender: string;
  type: 'text' | 'image' | 'file' | 'ai';
  content: string;
  fileName?: string;
  timestamp: string;
  readBy: string[];
}

export interface GroupInfo {
  roomId: string;
  groupName: string;
  creator: string;
  members: string[];
}

export interface ClientToServerEvents {
  register_user: (
    payload: { username: string },
    callback: (res: { success: boolean; message: string }) => void
  ) => void;
  create_group: (payload: { groupName: string; creator: string }) => void;
  join_group: (payload: { groupName: string; username: string }) => void;
  join_room: (payload: { roomId: string; username: string }) => void;
  send_message: (payload: {
    roomId: string;
    sender: string;
    type: 'text' | 'image' | 'file';
    content: string;
    fileName?: string;
  }) => void;
  typing: (payload: { roomId: string; username: string; isTyping: boolean }) => void;
  mark_read: (payload: { roomId: string; username: string }) => void;
}

export interface ServerToClientEvents {
  users_updated: (users: string[]) => void;
  groups_updated: (groups: GroupInfo[]) => void;
  chat_history: (messages: ChatMessage[]) => void;
  receive_message: (message: ChatMessage) => void;
  typing: (payload: { roomId: string; username: string; isTyping: boolean }) => void;
  messages_read: (payload: { roomId: string; username: string }) => void;
}

/**
 * Helper function สำหรับสร้าง Room ID ของแชทส่วนตัว (Private Room)
 * โดยจะนำชื่อผู้ใช้ 2 คนมาเรียงตามลำดับตัวอักษรเพื่อป้องกันความซ้ำซ้อนของการตั้งชื่อห้องสลับกัน
 */
export const getPrivateRoomId = (userA: string, userB: string): string => {
  const sorted = [userA, userB].sort();
  return `private_${sorted[0]}_${sorted[1]}`;
};

/**
 * Helper function สำหรับสร้าง Room ID ของกลุ่มแชท (Group Room)
 */
export const getGroupRoomId = (groupName: string): string => {
  return `group_${groupName}`;
};

/**
 * Per-socket server-side data (socket.data).
 * `username` MUST be set by the register_user handler on success;
 * all other handlers trust this value instead of payload.username.
 */
export interface SocketData {
  username?: string;
}
