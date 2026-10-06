// src/lib/roomPeople.ts
//
// Who in a meeting room can be added to the meeting's group from the room
// (components/groups/AddRoomPeopleToGroup.tsx): people signed in — their
// LiveKit identity is `user_…#nonce` — who are not members yet. Signed-out
// guests have no account to add, and you are already in it.

export interface RoomPerson {
  /** The user id, from the LiveKit identity. */
  userId: string;
  name: string;
}

/** A LiveKit identity's user id: what comes before "#nonce". */
export function userIdOfIdentity(identity: string | undefined | null): string {
  return (identity || "").split("#")[0];
}

/** The people here with an account who are not in the group, each once. */
export function notInGroup(people: RoomPerson[], memberIds: Set<string>, meId: string): RoomPerson[] {
  const seen = new Set<string>();
  return people.filter((p) => {
    if (!p.userId.startsWith("user_") || p.userId === meId || memberIds.has(p.userId) || seen.has(p.userId)) return false;
    seen.add(p.userId);
    return true;
  });
}
