import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../services/api';
import { TeamMemberItem, TeamInvitationItem, TeamJoinRequestItem, Role } from '../types';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../context/ConfirmContext';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import {
  Users,
  UserPlus,
  Mail,
  Shield,
  Trash2,
  Copy,
  Check,
  AlertCircle,
  QrCode,
  Send,
  RotateCcw,
  Ban,
  X,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  UserCheck,
  UserX,
  Clock,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Download,
} from 'lucide-react';
import { ExportDrawer } from '../components/export/ExportDrawer';

export const TeamPage: React.FC = () => {
  const queryClient = useQueryClient();
  const { user, role } = useAuth();
  const { showToast } = useToast();
  const { confirm } = useConfirm();
  const isOwner = role === 'OWNER';

  // Navigation tab: 'members' | 'invitations' | 'join-requests'
  const [activeTab, setActiveTab] = useState<'members' | 'invitations' | 'join-requests'>('members');

  // Export drawer state
  const [isExportDrawerOpen, setIsExportDrawerOpen] = useState(false);

  // Invite modal state
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('MEMBER');
  const [inviteError, setInviteError] = useState('');

  // Share invitation dialog (reveal-once)
  const [sharedInvitation, setSharedInvitation] = useState<TeamInvitationItem | null>(null);
  const [inviteQrDataUrl, setInviteQrDataUrl] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [actionSuccess, setActionSuccess] = useState('');

  // Direct send via WhatsApp state
  const [sendViaWaSessionId, setSendViaWaSessionId] = useState('');
  const [sendViaWaPhone, setSendViaWaPhone] = useState('');
  const [sendingWa, setSendingWa] = useState(false);
  const [waSentSuccess, setWaSentSuccess] = useState(false);

  // Pagination states
  const [memberPage, setMemberPage] = useState(1);
  const [memberPageSize, setMemberPageSize] = useState(20);

  // Join Requests states
  const [joinReqPage, setJoinReqPage] = useState(1);
  const [joinReqPageSize, setJoinReqPageSize] = useState(20);
  const [joinReqStatus, setJoinReqStatus] = useState<string>('PENDING');

  // Join Code dialog state (reveal-once)
  const [sharedJoinCode, setSharedJoinCode] = useState<{
    join_code: string;
    join_url: string;
  } | null>(null);
  const [joinCodeQrDataUrl, setJoinCodeQrDataUrl] = useState<string | null>(null);
  const [copiedJoinCode, setCopiedJoinCode] = useState(false);
  const [copiedJoinUrl, setCopiedJoinUrl] = useState(false);

  // Approve drawer state
  const [approveDrawerRequest, setApproveDrawerRequest] = useState<TeamJoinRequestItem | null>(null);
  const [selectedApproveRole, setSelectedApproveRole] = useState<Role>('MEMBER');

  // Queries
  const {
    data: membersResponse,
    isLoading: loadingMembers,
    error: membersError,
    refetch: refetchMembers,
  } = useQuery({
    queryKey: ['team-members', { memberPage, memberPageSize }],
    queryFn: () => api.getTeamMembers(memberPage, memberPageSize),
  });

  const members = membersResponse?.data || [];
  const memberMeta = membersResponse?.meta;
  const totalMemberPages =
    memberMeta?.total && memberMeta?.page_size
      ? Math.ceil(memberMeta.total / memberMeta.page_size)
      : 1;

  const {
    data: invitations = [],
    isLoading: loadingInvitations,
    refetch: refetchInvitations,
  } = useQuery({
    queryKey: ['team-invitations'],
    queryFn: () => api.getInvitations(),
  });

  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.getSessions(),
  });

  // Join Code query
  const {
    data: joinCodeData,
    refetch: refetchJoinCode,
  } = useQuery({
    queryKey: ['team-join-code'],
    queryFn: () => api.getJoinCode(),
    enabled: isOwner,
  });

  // Join Requests query
  const {
    data: joinRequestsResponse,
    isLoading: loadingJoinRequests,
    refetch: refetchJoinRequests,
  } = useQuery({
    queryKey: ['team-join-requests', { joinReqPage, joinReqPageSize, joinReqStatus }],
    queryFn: () =>
      api.getJoinRequests({
        page: joinReqPage,
        page_size: joinReqPageSize,
        status: joinReqStatus === 'ALL' ? undefined : joinReqStatus,
      }),
    enabled: isOwner,
  });

  const joinRequests = joinRequestsResponse?.data || [];
  const joinRequestMeta = joinRequestsResponse?.meta;
  const totalJoinRequestPages =
    joinRequestMeta?.total && joinRequestMeta?.page_size
      ? Math.ceil(joinRequestMeta.total / joinRequestMeta.page_size)
      : 1;

  // Generate QR code for shared invitation
  useEffect(() => {
    if (sharedInvitation?.invite_url) {
      QRCode.toDataURL(sharedInvitation.invite_url, { width: 200, margin: 2 })
        .then((url) => setInviteQrDataUrl(url))
        .catch(() => setInviteQrDataUrl(null));
    } else {
      setInviteQrDataUrl(null);
    }
  }, [sharedInvitation]);

  // Generate QR code for shared join code
  useEffect(() => {
    if (sharedJoinCode?.join_url) {
      QRCode.toDataURL(sharedJoinCode.join_url, { width: 200, margin: 2 })
        .then((url) => setJoinCodeQrDataUrl(url))
        .catch(() => setJoinCodeQrDataUrl(null));
    } else {
      setJoinCodeQrDataUrl(null);
    }
  }, [sharedJoinCode]);

  // Mutations
  const inviteMutation = useMutation({
    mutationFn: () => api.createInvitation(inviteEmail.trim(), inviteRole),
    onSuccess: (data) => {
      setInviteEmail('');
      setInviteRole('MEMBER');
      setInviteError('');
      setIsInviteModalOpen(false);
      setSharedInvitation(data);
      queryClient.invalidateQueries({ queryKey: ['team-invitations'] });
    },
    onError: (err: any) => {
      setInviteError(err.message || 'Gagal membuat undangan');
    },
  });

  const reissueMutation = useMutation({
    mutationFn: (id: string) => api.reissueInvitation(id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['team-invitations'] });
      setSharedInvitation(data);
    },
  });

  const revokeInvitationMutation = useMutation({
    mutationFn: (id: string) => api.revokeInvitation(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-invitations'] });
      setActionSuccess('Undangan berhasil dibatalkan.');
      setTimeout(() => setActionSuccess(''), 3000);
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, newRole }: { userId: string; newRole: Role }) =>
      api.updateTeamMember(userId, { role: newRole }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-members'] });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.removeTeamMember(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-members'] });
      setActionSuccess('Anggota tim berhasil dihapus.');
      setTimeout(() => setActionSuccess(''), 3000);
    },
  });

  // Join Code Mutations
  const rotateJoinCodeMutation = useMutation({
    mutationFn: () => api.rotateJoinCode(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['team-join-code'] });
      const joinUrl = data.join_url || `${window.location.origin}/join#code=${data.join_code}`;
      setSharedJoinCode({
        join_code: data.join_code || '',
        join_url: joinUrl,
      });
      setActionSuccess('Kode pendaftaran workspace berhasil dibuat/diputar.');
      setTimeout(() => setActionSuccess(''), 3000);
    },
    onError: (err: any) => {
      showToast('error', `Gagal membuat/memutar kode: ${err.message || 'Terjadi galat.'}`);
    },
  });

  const disableJoinCodeMutation = useMutation({
    mutationFn: () => api.disableJoinCode(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-join-code'] });
      setActionSuccess('Kode pendaftaran workspace berhasil dinonaktifkan.');
      setTimeout(() => setActionSuccess(''), 3000);
    },
    onError: (err: any) => {
      showToast('error', `Gagal menonaktifkan kode: ${err.message || 'Terjadi galat.'}`);
    },
  });

  // Join Request Approve & Reject Mutations
  const approveJoinRequestMutation = useMutation({
    mutationFn: ({ requestId, reqRole }: { requestId: string; reqRole: Role }) =>
      api.approveJoinRequest(requestId, reqRole),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-join-requests'] });
      queryClient.invalidateQueries({ queryKey: ['team-members'] });
      setApproveDrawerRequest(null);
      setActionSuccess('Permintaan bergabung berhasil disetujui. Pengguna kini menjadi anggota aktif.');
      setTimeout(() => setActionSuccess(''), 3000);
    },
    onError: (err: any) => {
      showToast('error', `Gagal menyetujui permintaan: ${err.message || 'Terjadi galat.'}`);
    },
  });

  const rejectJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => api.rejectJoinRequest(requestId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-join-requests'] });
      setActionSuccess('Permintaan bergabung telah ditolak.');
      setTimeout(() => setActionSuccess(''), 3000);
    },
    onError: (err: any) => {
      showToast('error', `Gagal menolak permintaan: ${err.message || 'Terjadi galat.'}`);
    },
  });

  const handleInviteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviteError('');
    inviteMutation.mutate();
  };

  const copyInviteLink = () => {
    if (sharedInvitation?.invite_url) {
      navigator.clipboard.writeText(sharedInvitation.invite_url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  const handleSendViaGateway = async () => {
    if (!sendViaWaSessionId || !sendViaWaPhone.trim() || !sharedInvitation?.invite_url) return;
    try {
      setSendingWa(true);
      const text = `Halo, Anda diundang untuk bergabung ke workspace WhatsApp Gateway.\nKlik tautan ini untuk menerima undangan:\n${sharedInvitation.invite_url}\nTautan berlaku hingga: ${new Date(
        sharedInvitation.expires_at
      ).toLocaleString()}`;

      await api.sendMessage(
        sendViaWaSessionId,
        sendViaWaPhone.trim().replace(/[^0-9]/g, ''),
        text
      );
      setWaSentSuccess(true);
      setTimeout(() => setWaSentSuccess(false), 4000);
    } catch (err: any) {
      showToast('error', `Gagal mengirim undangan via WhatsApp: ${err.message || 'Terjadi galat.'}`);
    } finally {
      setSendingWa(false);
    }
  };

  const pendingJoinCount = joinRequests.filter((r) => r.status === 'PENDING').length;

  if (loadingMembers && loadingInvitations) {
    return <LoadingState message="Memuat data tim dan anggota..." />;
  }

  if (membersError) {
    return (
      <ErrorState
        message={(membersError as Error).message}
        onRetry={() => {
          refetchMembers();
          refetchInvitations();
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Manajemen Tim</h1>
          <p className="text-sm text-slate-500">
            Kelola anggota workspace, bagikan tautan undangan, dan atur kode pendaftaran resmi.
          </p>
        </div>
        {isOwner && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsExportDrawerOpen(true)}
              className="inline-flex items-center gap-2 px-3.5 py-2 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl text-xs sm:text-sm font-bold text-slate-700 transition shadow-xs"
              title="Ekspor seluruh daftar anggota tim dan hak akses"
            >
              <Download className="w-4 h-4 text-slate-500" />
              <span>Ekspor Anggota</span>
            </button>

            <button
              onClick={() => {
                setInviteError('');
                setIsInviteModalOpen(true);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 rounded-xl text-xs sm:text-sm font-bold text-white hover:bg-emerald-700 transition shadow-sm"
            >
              <UserPlus className="w-4 h-4" />
              Undang Anggota
            </button>
          </div>
        )}
      </div>

      {actionSuccess && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-700 flex items-center gap-2 animate-in fade-in duration-150">
          <Check className="w-4 h-4 shrink-0" />
          <span>{actionSuccess}</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-px">
        <button
          onClick={() => setActiveTab('members')}
          className={`inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-bold border-b-2 transition ${
            activeTab === 'members'
              ? 'border-emerald-600 text-emerald-700'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>Anggota Aktif</span>
          <span className="px-2 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-600 font-mono">
            {memberMeta?.total ?? members.length}
          </span>
        </button>

        {isOwner && (
          <>
            <button
              onClick={() => setActiveTab('invitations')}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-bold border-b-2 transition ${
                activeTab === 'invitations'
                  ? 'border-emerald-600 text-emerald-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <Mail className="w-4 h-4" />
              <span>Undangan</span>
              <span className="px-2 py-0.5 rounded-full text-[11px] bg-amber-100 text-amber-800 font-mono">
                {invitations.filter((i) => i.status === 'PENDING').length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('join-requests')}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-bold border-b-2 transition ${
                activeTab === 'join-requests'
                  ? 'border-emerald-600 text-emerald-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <KeyRound className="w-4 h-4" />
              <span>Kode & Permintaan Bergabung</span>
              {pendingJoinCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-800 font-bold animate-pulse font-mono">
                  {pendingJoinCount} baru
                </span>
              )}
            </button>
          </>
        )}
      </div>

      {/* TAB 1: Anggota Tim */}
      {activeTab === 'members' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5 text-slate-600" />
              <h2 className="font-bold text-slate-900 text-sm">Daftar Anggota Workspace</h2>
            </div>
          </div>

          <div className="divide-y divide-slate-100">
            {members.map((m) => {
              const isSelf = m.is_me || m.user_id === user?.id;
              const canModify = isOwner && !isSelf;

              return (
                <div
                  key={m.user_id}
                  className="px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 hover:bg-slate-50 transition"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-teal-500/20 text-emerald-700 border border-emerald-500/20 flex items-center justify-center font-bold text-sm">
                      {(m.email || 'US').slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-900 text-xs sm:text-sm">
                          {m.email || m.user_id}
                        </span>
                        {isSelf && (
                          <span className="text-[10px] bg-emerald-50 text-emerald-700 font-bold px-2 py-0.5 rounded-full border border-emerald-200">
                            Anda
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        Bergabung: {new Date(m.joined_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    {canModify && role === 'OWNER' && !isSelf ? (
                      <select
                        value={m.role}
                        onChange={(e) =>
                          updateRoleMutation.mutate({
                            userId: m.user_id,
                            newRole: e.target.value as Role,
                          })
                        }
                        className="px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-xl bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      >
                        <option value="MEMBER">MEMBER</option>
                        <option value="VIEWER">VIEWER</option>
                      </select>
                    ) : (
                      <span
                        className={`text-xs font-bold px-3 py-1 rounded-full ${
                          m.role === 'OWNER'
                            ? 'bg-purple-50 text-purple-700 border border-purple-200'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {m.role}
                      </span>
                    )}

                    {canModify && !isSelf && (
                      <button
                        onClick={async () => {
                          const ok = await confirm({
                            title: 'Hapus Anggota Workspace',
                            message: `Yakin ingin mengeluarkan ${m.email || m.user_id} dari workspace? Seluruh API key dan hak akses administratif yang dibuatnya akan dicabut seketika.`,
                            confirmLabel: 'Hapus Anggota',
                            variant: 'danger',
                          });
                          if (ok) {
                            removeMemberMutation.mutate(m.user_id);
                          }
                        }}
                        className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition"
                        title="Hapus Anggota"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Member Pagination */}
          {memberMeta && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-6 py-3.5 border-t border-slate-100 text-xs text-slate-500">
              <div className="flex items-center gap-2">
                <span>Tampilkan:</span>
                <select
                  value={memberPageSize}
                  onChange={(e) => {
                    setMemberPageSize(Number(e.target.value));
                    setMemberPage(1);
                  }}
                  className="px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
                <span>anggota per halaman</span>
                <span className="text-slate-300 mx-1">•</span>
                <span>
                  Halaman {memberMeta.page || 1} dari {totalMemberPages} ({memberMeta.total ?? members.length} total)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setMemberPage((p) => Math.max(1, p - 1))}
                  disabled={memberPage <= 1}
                  className="px-3 py-1.5 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-40 transition flex items-center gap-1 font-medium"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>Sebelumnya</span>
                </button>
                <button
                  onClick={() => setMemberPage((p) => p + 1)}
                  disabled={memberPage >= totalMemberPages}
                  className="px-3 py-1.5 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-40 transition flex items-center gap-1 font-medium"
                >
                  <span>Selanjutnya</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: Undangan */}
      {activeTab === 'invitations' && isOwner && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Mail className="w-5 h-5 text-slate-600" />
              <h2 className="font-bold text-slate-900 text-sm">
                Riwayat & Status Undangan Tim
              </h2>
            </div>
          </div>

          {invitations.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-xs">
              Belum ada undangan yang dibuat. Klik "Undang Anggota" untuk memulai.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {invitations.map((inv) => (
                <div
                  key={inv.id}
                  className="px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900 text-sm">{inv.email}</span>
                      <span className="bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold">
                        {inv.role}
                      </span>
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                          inv.status === 'PENDING'
                            ? 'bg-amber-50 text-amber-700 border border-amber-200'
                            : inv.status === 'ACCEPTED'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {inv.status}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1">
                      Berlaku sampai: {new Date(inv.expires_at).toLocaleString()}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {inv.status === 'PENDING' && (
                      <>
                        <button
                          onClick={() => reissueMutation.mutate(inv.id)}
                          disabled={reissueMutation.isPending}
                          className="px-3 py-1.5 bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          Buat Ulang Tautan
                        </button>
                        <button
                          onClick={() => setSharedInvitation(inv)}
                          className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition"
                        >
                          <Copy className="w-3.5 h-3.5" />
                          Bagikan
                        </button>
                        <button
                          onClick={() => revokeInvitationMutation.mutate(inv.id)}
                          className="p-2 text-slate-400 hover:text-rose-600 rounded-xl transition hover:bg-rose-50"
                          title="Batalkan Undangan"
                        >
                          <Ban className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: Permintaan Bergabung & Kode Workspace (Fase H3 / ADR-036) */}
      {activeTab === 'join-requests' && isOwner && (
        <div className="space-y-6">
          {/* Card: Kode Workspace */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-2xl bg-emerald-50 text-emerald-600 border border-emerald-200">
                  <KeyRound className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm">Kode Pendaftaran Workspace (Join Code)</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Izinkan calon staf atau anggota mendaftar secara mandiri melalui URL /join dengan kode resmi ini.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {joinCodeData?.enabled ? (
                  <>
                    <button
                      onClick={async () => {
                        const ok = await confirm({
                          title: 'Putar Kode Pendaftaran Baru',
                          message:
                            'Memutar kode akan membatalkan kode pendaftaran lama segera. Calon anggota harus menggunakan kode pendaftaran baru untuk mendaftar. Lanjutkan?',
                          confirmLabel: 'Putar Kode Baru',
                          variant: 'warning',
                        });
                        if (ok) {
                          rotateJoinCodeMutation.mutate();
                        }
                      }}
                      disabled={rotateJoinCodeMutation.isPending}
                      className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition shadow-xs flex items-center gap-1.5"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Putar Kode Baru</span>
                    </button>
                    <button
                      onClick={async () => {
                        const ok = await confirm({
                          title: 'Nonaktifkan Kode Pendaftaran',
                          message:
                            'Yakin ingin menonaktifkan kode pendaftaran workspace ini? Calon anggota tidak lagi dapat mendaftar mandiri via /join sampai kode diaktifkan kembali.',
                          confirmLabel: 'Nonaktifkan Kode',
                          variant: 'danger',
                        });
                        if (ok) {
                          disableJoinCodeMutation.mutate();
                        }
                      }}
                      disabled={disableJoinCodeMutation.isPending}
                      className="px-3.5 py-2 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-xl text-xs font-bold transition flex items-center gap-1.5"
                    >
                      <Ban className="w-3.5 h-3.5" />
                      <span>Nonaktifkan Kode</span>
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => rotateJoinCodeMutation.mutate()}
                    disabled={rotateJoinCodeMutation.isPending}
                    className="px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-xs font-bold transition shadow-sm flex items-center gap-1.5"
                  >
                    <KeyRound className="w-4 h-4" />
                    <span>Aktifkan & Buat Kode Workspace</span>
                  </button>
                )}
              </div>
            </div>

            <div className="pt-4 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
                <span className="text-[11px] font-semibold text-slate-400 block">Status Kode</span>
                <span className={`inline-flex items-center gap-1.5 mt-1 font-bold ${
                  joinCodeData?.enabled ? 'text-emerald-600' : 'text-slate-500'
                }`}>
                  <span className={`w-2 h-2 rounded-full ${joinCodeData?.enabled ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                  {joinCodeData?.enabled ? 'AKTIF (Siap Menerima Pendaftaran)' : 'TIDAK AKTIF'}
                </span>
              </div>
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
                <span className="text-[11px] font-semibold text-slate-400 block">Dibuat / Diputar Pada</span>
                <span className="text-slate-700 font-medium block mt-1">
                  {joinCodeData?.created_at ? new Date(joinCodeData.created_at).toLocaleString('id-ID') : '-'}
                </span>
              </div>
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
                <span className="text-[11px] font-semibold text-slate-400 block">Pengelola Kode</span>
                <span className="text-slate-700 font-medium block mt-1">
                  {joinCodeData?.created_by?.email || 'Administrator Workspace'}
                </span>
              </div>
            </div>
          </div>

          {/* Card: Daftar Permintaan Bergabung */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-slate-600" />
                <h3 className="font-bold text-slate-900 text-sm">Permintaan Bergabung Masuk</h3>
              </div>

              {/* Status Filter */}
              <div className="flex items-center gap-1.5 bg-slate-50 p-1 rounded-xl border border-slate-200">
                {['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'ALL'].map((st) => (
                  <button
                    key={st}
                    onClick={() => {
                      setJoinReqStatus(st);
                      setJoinReqPage(1);
                    }}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition ${
                      joinReqStatus === st
                        ? 'bg-white text-emerald-700 shadow-xs'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {st === 'ALL' ? 'Semua' : st}
                  </button>
                ))}
              </div>
            </div>

            {loadingJoinRequests ? (
              <div className="p-8 text-center text-slate-400 text-xs">
                Memuat daftar pengajuan bergabung...
              </div>
            ) : joinRequests.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-xs">
                Tidak ada permintaan bergabung dengan status "{joinReqStatus}".
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {joinRequests.map((req) => (
                  <div
                    key={req.id}
                    className="px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 hover:bg-slate-50 transition"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900 text-xs sm:text-sm">
                          {req.email}
                        </span>
                        <span
                          className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                            req.status === 'PENDING'
                              ? 'bg-amber-50 text-amber-700 border border-amber-200'
                              : req.status === 'APPROVED'
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : req.status === 'REJECTED'
                              ? 'bg-rose-50 text-rose-700 border border-rose-200'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {req.status}
                        </span>
                        {req.role && (
                          <span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded-md text-[10px] font-mono font-bold">
                            Peran: {req.role}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                        <span>Diajukan: {new Date(req.requested_at).toLocaleString('id-ID')}</span>
                        <span>•</span>
                        <span>Kedaluwarsa: {new Date(req.expires_at).toLocaleString('id-ID')}</span>
                        {req.decided_by && (
                          <>
                            <span>•</span>
                            <span>Diputuskan oleh: {req.decided_by.email}</span>
                          </>
                        )}
                      </div>
                    </div>

                    {req.status === 'PENDING' && (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            setApproveDrawerRequest(req);
                            setSelectedApproveRole('MEMBER');
                          }}
                          className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-xs"
                        >
                          <UserCheck className="w-3.5 h-3.5" />
                          <span>Setujui</span>
                        </button>
                        <button
                          onClick={async () => {
                            const ok = await confirm({
                              title: 'Tolak Permintaan Bergabung',
                              message: `Yakin ingin menolak permohonan bergabung dari ${req.email}?`,
                              confirmLabel: 'Tolak Permintaan',
                              variant: 'danger',
                            });
                            if (ok) {
                              rejectJoinRequestMutation.mutate(req.id);
                            }
                          }}
                          disabled={rejectJoinRequestMutation.isPending}
                          className="px-3.5 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-xl text-xs font-bold transition flex items-center gap-1.5"
                        >
                          <UserX className="w-3.5 h-3.5" />
                          <span>Tolak</span>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Pagination */}
            {joinRequestMeta && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-6 py-3.5 border-t border-slate-100 text-xs text-slate-500">
                <div className="flex items-center gap-2">
                  <span>Tampilkan:</span>
                  <select
                    value={joinReqPageSize}
                    onChange={(e) => {
                      setJoinReqPageSize(Number(e.target.value));
                      setJoinReqPage(1);
                    }}
                    className="px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                  >
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                  </select>
                  <span>pengajuan per halaman</span>
                  <span className="text-slate-300 mx-1">•</span>
                  <span>
                    Halaman {joinRequestMeta.page || 1} dari {totalJoinRequestPages} ({joinRequestMeta.total ?? joinRequests.length} total)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setJoinReqPage((p) => Math.max(1, p - 1))}
                    disabled={joinReqPage <= 1}
                    className="px-3 py-1.5 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-40 transition flex items-center gap-1 font-medium"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Sebelumnya</span>
                  </button>
                  <button
                    onClick={() => setJoinReqPage((p) => p + 1)}
                    disabled={joinReqPage >= totalJoinRequestPages}
                    className="px-3 py-1.5 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-40 transition flex items-center gap-1 font-medium"
                  >
                    <span>Selanjutnya</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Drawer: Undang Anggota Baru */}
      {isInviteModalOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setIsInviteModalOpen(false)}
          />
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-bold text-slate-900 text-sm">Undang Anggota Tim</h2>
              <button
                onClick={() => setIsInviteModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleInviteSubmit} className="flex-1 flex flex-col justify-between overflow-y-auto">
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Alamat Email Calon Anggota
                  </label>
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="rekan@perusahaan.com"
                    required
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Peran / Hak Akses di Workspace
                  </label>
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as Role)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  >
                    <option value="MEMBER">MEMBER (Kirim pesan & kelola sesi)</option>
                    <option value="VIEWER">VIEWER (Hanya pantau dashboard & riwayat)</option>
                  </select>
                </div>

                {inviteError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{inviteError}</span>
                  </div>
                )}

                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-[11px] text-slate-500 leading-relaxed">
                  Catatan: Sistem tidak mengirim email otomatis. Setelah membuat undangan, Anda dapat menyalin tautan, membagikan QR, atau mengirimkannya langsung lewat WhatsApp.
                </div>
              </div>

              <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsInviteModalOpen(false)}
                  className="px-4 py-2 border border-slate-300 rounded-xl text-xs font-medium text-slate-700 hover:bg-slate-100 transition"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={inviteMutation.isPending}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition disabled:opacity-50"
                >
                  {inviteMutation.isPending ? 'Membuat...' : 'Buat Tautan Undangan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Drawer: Bagikan Undangan (Reveal-once: Link, QR, WhatsApp) */}
      {sharedInvitation && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setSharedInvitation(null)}
          />
          <div className="relative w-full max-w-lg bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h3 className="font-bold text-slate-900 text-sm truncate pr-2">
                Bagikan Undangan untuk {sharedInvitation.email}
              </h3>
              <button
                onClick={() => setSharedInvitation(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="space-y-1.5">
                <span className="text-xs font-semibold text-slate-700 block">
                  1. Salin Tautan Langsung
                </span>
                <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between gap-2">
                  <span className="text-xs font-mono text-slate-800 truncate">
                    {sharedInvitation.invite_url || '(URL belum terpasang)'}
                  </span>
                  <button
                    onClick={copyInviteLink}
                    className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700 transition shrink-0 flex items-center gap-1"
                  >
                    {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedLink ? 'Tersalin' : 'Salin'}
                  </button>
                </div>
              </div>

              {inviteQrDataUrl && (
                <div className="space-y-2 pt-3 border-t border-slate-100 text-center">
                  <span className="text-xs font-semibold text-slate-700 block">
                    2. Pindai QR Code untuk Bergabung
                  </span>
                  <img
                    src={inviteQrDataUrl}
                    alt="Invitation QR Code"
                    className="w-40 h-40 mx-auto rounded-xl border border-slate-200 p-1.5 bg-white shadow-xs"
                  />
                </div>
              )}

              <div className="space-y-2 pt-3 border-t border-slate-100">
                <span className="text-xs font-semibold text-slate-700 block">
                  3. Kirim Melalui WhatsApp
                </span>
                <div className="flex flex-col sm:flex-row gap-2">
                  <a
                    href={`https://wa.me/?text=${encodeURIComponent(
                      `Halo, silakan bergabung ke workspace kita melalui tautan berikut:\n${sharedInvitation.invite_url}`
                    )}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 py-2 px-3 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Buka WhatsApp Web / App
                  </a>
                </div>

                {sessions.filter((s) => s.status === 'CONNECTED').length > 0 && (
                  <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2.5 mt-2">
                    <span className="text-[11px] font-medium text-slate-600 block">
                      Atau kirim otomatis dari Sesi Gateway aktif:
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <select
                        value={sendViaWaSessionId}
                        onChange={(e) => setSendViaWaSessionId(e.target.value)}
                        className="px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs bg-white"
                      >
                        <option value="">Pilih Sesi Pengirim</option>
                        {sessions
                          .filter((s) => s.status === 'CONNECTED')
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.session_name || s.id.slice(0, 8)}
                            </option>
                          ))}
                      </select>
                      <input
                        type="text"
                        value={sendViaWaPhone}
                        onChange={(e) => setSendViaWaPhone(e.target.value)}
                        placeholder="Nomor WA (62812...)"
                        className="px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs"
                      />
                    </div>

                    {waSentSuccess && (
                      <p className="text-[11px] text-emerald-600 font-medium">
                        Pesan undangan berhasil dikirim ke nomor WhatsApp tujuan!
                      </p>
                    )}

                    <button
                      type="button"
                      onClick={handleSendViaGateway}
                      disabled={sendingWa || !sendViaWaSessionId || !sendViaWaPhone.trim()}
                      className="w-full py-2 bg-slate-800 text-white rounded-lg text-xs font-semibold hover:bg-slate-900 transition disabled:opacity-50"
                    >
                      {sendingWa ? 'Mengirim...' : 'Kirim Pesan Undangan Sekarang'}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex justify-end">
              <button
                onClick={() => setSharedInvitation(null)}
                className="px-5 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl text-xs font-semibold transition"
              >
                Selesai
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drawer: Bagikan Kode Workspace (Reveal-Once Join Code) */}
      {sharedJoinCode && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setSharedJoinCode(null)}
          />
          <div className="relative w-full max-w-lg bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-emerald-50">
              <div className="flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-emerald-600" />
                <h3 className="font-bold text-slate-900 text-sm">
                  Kode Akses Pendaftaran Workspace
                </h3>
              </div>
              <button
                onClick={() => setSharedJoinCode(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 leading-relaxed">
                <strong>PENTING:</strong> Kode pendaftaran ini <strong>hanya ditampilkan sekali sekarang</strong>. Bagikan kepada calon anggota yang berhak. Siapa pun dengan kode ini dapat mengajukan permohonan akun yang tetap memerlukan persetujuan Anda.
              </div>

              {/* Join Code */}
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-slate-700">
                  Kode Workspace Rahasia
                </label>
                <div className="flex items-center gap-2 p-3 bg-slate-900 text-emerald-400 font-mono text-sm font-bold rounded-xl border border-slate-800">
                  <span className="flex-1 tracking-wider text-center select-all">{sharedJoinCode.join_code}</span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(sharedJoinCode.join_code);
                      setCopiedJoinCode(true);
                      setTimeout(() => setCopiedJoinCode(false), 2000);
                    }}
                    className="p-1.5 bg-slate-800 text-slate-200 hover:text-white rounded-lg transition"
                    title="Salin kode"
                  >
                    {copiedJoinCode ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Join URL */}
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-slate-700">
                  Tautan Gabung Otomatis (/join)
                </label>
                <div className="flex items-center gap-2 p-2.5 bg-slate-50 border border-slate-200 rounded-xl">
                  <span className="flex-1 font-mono text-xs text-slate-800 truncate select-all">{sharedJoinCode.join_url}</span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(sharedJoinCode.join_url);
                      setCopiedJoinUrl(true);
                      setTimeout(() => setCopiedJoinUrl(false), 2000);
                    }}
                    className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700 transition shrink-0 flex items-center gap-1"
                  >
                    {copiedJoinUrl ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedJoinUrl ? 'Tersalin' : 'Salin URL'}</span>
                  </button>
                </div>
              </div>

              {/* QR Code */}
              {joinCodeQrDataUrl && (
                <div className="space-y-2 pt-3 border-t border-slate-100 text-center">
                  <span className="text-xs font-semibold text-slate-700 block">
                    Pindai QR untuk Membuka Halaman Gabung
                  </span>
                  <img
                    src={joinCodeQrDataUrl}
                    alt="Join Workspace QR Code"
                    className="w-40 h-40 mx-auto rounded-xl border border-slate-200 p-1.5 bg-white shadow-xs"
                  />
                </div>
              )}

              {/* Send via WhatsApp */}
              <div className="space-y-2 pt-3 border-t border-slate-100">
                <span className="text-xs font-semibold text-slate-700 block">
                  Kirim Melalui WhatsApp
                </span>
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(
                    `Halo, silakan bergabung ke workspace tim kami menggunakan kode pendaftaran:\nKode: ${sharedJoinCode.join_code}\nAtau klik tautan:\n${sharedJoinCode.join_url}`
                  )}`}
                  target="_blank"
                  rel="noreferrer"
                  className="w-full py-2 px-3 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Kirim Pesan via WhatsApp Web / App
                </a>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex justify-end">
              <button
                onClick={() => setSharedJoinCode(null)}
                className="px-5 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold transition"
              >
                Tutup & Selesai
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drawer: Setujui Permintaan Bergabung */}
      {approveDrawerRequest && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setApproveDrawerRequest(null)}
          />
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <UserCheck className="w-5 h-5 text-emerald-600" />
                <h2 className="font-bold text-slate-900 text-sm">Setujui Permintaan Bergabung</h2>
              </div>
              <button
                onClick={() => setApproveDrawerRequest(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <span className="text-[11px] text-slate-400 block">Pemohon Akun</span>
                <span className="text-sm font-bold text-slate-900 block">{approveDrawerRequest.email}</span>
                <span className="text-[11px] text-slate-500 block">
                  Diajukan: {new Date(approveDrawerRequest.requested_at).toLocaleString('id-ID')}
                </span>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-slate-700">
                  Tentukan Peran / Hak Akses di Workspace
                </label>
                <select
                  value={selectedApproveRole}
                  onChange={(e) => setSelectedApproveRole(e.target.value as Role)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                >
                  <option value="MEMBER">MEMBER (Kirim pesan & kelola sesi)</option>
                  <option value="VIEWER">VIEWER (Hanya pantau dashboard & pesan)</option>
                  {role === 'OWNER' && (
                    <option value="OWNER">OWNER (Pemilik bersama penuh)</option>
                  )}
                </select>
                <p className="text-[11px] text-slate-500 leading-relaxed mt-1">
                  Setelah disetujui, akun pemohon akan otomatis berstatus ACTIVE dan dapat langsung masuk ke workspace ini menggunakan kata sandi yang telah dibuatnya.
                </p>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setApproveDrawerRequest(null)}
                className="px-4 py-2 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700 hover:bg-slate-100 transition"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={approveJoinRequestMutation.isPending}
                onClick={() =>
                  approveJoinRequestMutation.mutate({
                    requestId: approveDrawerRequest.id,
                    reqRole: selectedApproveRole,
                  })
                }
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition disabled:opacity-50"
              >
                {approveJoinRequestMutation.isPending ? 'Menyetujui...' : 'Konfirmasi & Aktifkan Anggota'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export Drawer */}
      <ExportDrawer
        isOpen={isExportDrawerOpen}
        onClose={() => setIsExportDrawerOpen(false)}
        initialType="members"
        lockType={true}
      />
    </div>
  );
};
