import { useState, useCallback } from 'react';
import { WebSocketProvider } from './hooks/useWebSocket';
import { ToastProvider } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';

export default function App() {
  const [selectedLeft, setSelectedLeft] = useState<string | null>(null);
  const [selectedRight, setSelectedRight] = useState<string | null>(null);

  const handleSelectSession = useCallback((id: string) => {
    setSelectedLeft(id);
  }, []);

  const handleSelectRight = useCallback((id: string) => {
    // If already showing in left panel, move to right instead
    if (id === selectedLeft) {
      setSelectedLeft(null);
    }
    setSelectedRight(id);
  }, [selectedLeft]);

  return (
    <WebSocketProvider>
      <ToastProvider>
        <ErrorBoundary>
          <Layout
            selectedLeft={selectedLeft}
            selectedRight={selectedRight}
            onSelectSession={handleSelectSession}
            onSelectRight={handleSelectRight}
            onCloseLeft={() => setSelectedLeft(null)}
            onCloseRight={() => setSelectedRight(null)}
          />
        </ErrorBoundary>
      </ToastProvider>
    </WebSocketProvider>
  );
}
