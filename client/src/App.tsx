import { useState } from 'react';
import { WebSocketProvider, useWebSocket } from './hooks/useWebSocket';

function Dashboard() {
  const { sessions, connectionStatus } = useWebSocket();
  const [_selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  void setSelectedSessionId; // will be used in Phase 1

  const dotColor = connectionStatus === 'connected' ? '#a6e3a1'
    : connectionStatus === 'reconnecting' ? '#f9e2af'
    : '#f38ba8';

  return (
    <div style={{ padding: '24px', color: 'var(--ctp-text)' }}>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: 0, fontSize: '1.5rem' }}>
        <span style={{
          width: 10, height: 10, borderRadius: '50%',
          backgroundColor: dotColor, display: 'inline-block',
        }} />
        Control Center
      </h1>
      <p style={{ color: 'var(--ctp-subtext0)', marginTop: '12px' }}>
        {sessions.length} sessions loaded &middot; WebSocket {connectionStatus}
      </p>
    </div>
  );
}

export default function App() {
  return (
    <WebSocketProvider>
      <Dashboard />
    </WebSocketProvider>
  );
}
