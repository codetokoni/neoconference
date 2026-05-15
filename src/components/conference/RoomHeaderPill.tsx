'use client';

import { useParticipants } from '@livekit/components-react';

interface RoomHeaderPillProps {
  roomName: string;
}

export default function RoomHeaderPill({ roomName }: RoomHeaderPillProps) {
  const count = useParticipants().length;

  return (
    <div className="flex justify-between items-center px-4 py-2">
      {/* Room code pill */}
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 backdrop-blur-sm"
        style={{
          background: 'rgba(255,255,255,0.04)',
          border: '0.5px solid rgba(255,255,255,0.08)',
        }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"
          style={{ boxShadow: '0 0 6px #22d3ee' }}
        />
        <span className="text-[10px] text-zinc-300 tracking-wide">{roomName}</span>
      </span>

      {/* Participant count */}
      <span className="text-[10px] text-zinc-500 tracking-widest uppercase">
        {count} IN ROOM
      </span>
    </div>
  );
}
