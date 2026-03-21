import { useState } from 'react';
import { WebSocketProvider } from './hooks/useWebSocket';
import { ToastProvider } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';

export default function App() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  return (
    <WebSocketProvider>
      <ToastProvider>
        <ErrorBoundary>
          <Layout
            selectedSessionId={selectedSessionId}
            onSelectSession={setSelectedSessionId}
            onCloseDetail={() => setSelectedSessionId(null)}
          />
        </ErrorBoundary>
      </ToastProvider>
    </WebSocketProvider>
  );
}
