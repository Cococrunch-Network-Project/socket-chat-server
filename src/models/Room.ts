import { Schema, model } from 'mongoose';

/**
 * rooms collection
 * One document per chat room (private or group).
 */
const roomSchema = new Schema(
  {
    // R5: unique room id, e.g. "private_Beam_Mail" or "group_NetProj"
    roomId: { type: String, required: true, unique: true },
    // Room type: private (1-on-1) or group
    type: { type: String, enum: ['private', 'group'], required: true },
    // R8, R9: group display name (group rooms only)
    // Max 94 chars so "group_" + name fits ROOM_ID_MAX (100) in messageService
    groupName: { type: String, trim: true, maxlength: 94 },
    // R8: username of the group creator
    creator: { type: String },
    // R8–R10: member usernames; a new group starts with [creator] only
    members: { type: [String], default: [] },
  },
  // Adds createdAt automatically (no updatedAt needed)
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const RoomModel = model('Room', roomSchema);
