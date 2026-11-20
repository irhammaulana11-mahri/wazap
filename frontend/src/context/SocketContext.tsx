import React, { createContext, useContext, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';
import { tokenStore, api } from '../services/api';
import { useQueryClient } from '@tanstack/react-query';

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
  isConnecting: boolean;
}

const SocketContext = createContext<SocketContextType>({
  socket: null,
  isConnected: false,
  isConnecting: false,
});

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, tenant } = useAuth();
  const { showToast } = useToast();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    const token = tokenStore.get();
    if (!isAuthenticated || !token) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
        setIsConnected(false);
      }
      return;
    }

    setIsConnecting(true);

    // Socket.IO path per docs/04_INTEGRATION/SOCKET_EVENTS.md: /api/v1/realtime
    const s = io(window.location.origin, {
      path: '/api/v1/realtime',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });

    s.on('connect', () => {
      setIsConnected(true);
      setIsConnecting(false);
      // Contract rule: Refetch state after reconnect because events may be missed
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: ['chats'] });
      queryClient.invalidateQueries({ queryKey: ['usage-summary'] });
    });

    s.on('ready', (payload) => {
      // Received server ready signal
      console.debug('Socket realtime ready:', payload);
    });

    s.on('disconnect', () => {
      setIsConnected(false);
    });

    s.on('connect_error', async (err: any) => {
      setIsConnected(false);
      setIsConnecting(false);
      if (err?.data?.code === 'UNAUTHENTICATED') {
        // Refresh token and update socket auth
        try {
          const refreshed = await api.refresh();
          if (refreshed?.access_token) {
            s.auth = { token: refreshed.access_token };
            s.connect();
          }
        } catch {
          // ignore
        }
      }
    });

    // Realtime events
    s.on('session.status', () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['usage-summary'] });
    });

    s.on('session.qr', (data) => {
      queryClient.invalidateQueries({ queryKey: ['session-qr', data?.data?.session_id] });
    });

    s.on('session.connected', (data) => {
      showToast('success', 'Sesi WhatsApp berhasil terhubung!', 'Perangkat Aktif');
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['usage-summary'] });
    });

    s.on('session.disconnected', () => {
      showToast('error', 'Sesi WhatsApp terputus atau logged out.', 'Perangkat Terputus');
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['usage-summary'] });
    });

    s.on('message.incoming', (data) => {
      const fromNumber = data?.data?.from ? `+${data.data.from}` : 'Nomor WhatsApp';
      showToast('info', `Pesan masuk baru dari ${fromNumber}`, 'Pesan Masuk');
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: ['chats'] });
      queryClient.invalidateQueries({ queryKey: ['usage-summary'] });
    });

    s.on('message.status', () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: ['usage-summary'] });
    });

    s.on('realtime.resync', () => {
      queryClient.invalidateQueries();
    });

    s.on('auth.expired', async () => {
      try {
        const refreshed = await api.refresh();
        if (refreshed?.access_token) {
          s.auth = { token: refreshed.access_token };
          s.connect();
        }
      } catch {
        // Handled by auth interceptor
      }
    });

    setSocket(s);

    return () => {
      s.disconnect();
    };
  }, [isAuthenticated, tenant?.id, queryClient]);

  return (
    <SocketContext.Provider value={{ socket, isConnected, isConnecting }}>
      {children}
    </SocketContext.Provider>
  );
};

export const useSocket = () => useContext(SocketContext);
