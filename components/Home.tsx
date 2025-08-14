import { supabase } from '@/lib/supabase';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, AppStateStatus, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import 'react-native-get-random-values';
import { v4 as uuidv4 } from 'uuid';

// -----------------------
// Types
// -----------------------
export type Delivery = {
  id: string;
  dateISO: string; // e.g., '2025-08-10'
  carMake: string;
  carModel: string;
  reg: string;
  pickup: string;
  dropoff: string;
  distanceKm: number; // numeric km
  ratePerKm: number; // £ per km
  fixedFee: number; // base fee per job
  transportExpense: number; // reimbursed expenses (count toward income)
  earnings: number; // computed or manual override
  status: 'pending' | 'completed' | 'aborted' | 'cancelled';
  notes?: string;
};

export type Draft = Omit<Delivery, 'id'> & { id?: string };

const STORAGE_KEY = 'car_delivery_tracker__deliveries_v1';

// -----------------------
// Local helpers
// -----------------------
function currency(n: number) {
  if (isNaN(n)) return '£0.00';
  return `£${n.toFixed(2)}`;
}
function iso(d: Date) { return d.toISOString().slice(0, 10); }
function getWeekRange(date = new Date()) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Monday start
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { startISO: iso(monday), endISO: iso(sunday) };
}
function isWithin(dateISO: string, startISO: string, endISO: string) { return dateISO >= startISO && dateISO <= endISO; }

async function loadCache(): Promise<Delivery[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try { const parsed: Delivery[] = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
async function saveCache(list: Delivery[]) { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }

// -----------------------
// Supabase mapping
// -----------------------
// Table columns expected (snake_case): see your SQL migration
// id, user_id, date_iso, car_make, car_model, reg, pickup, dropoff,
// distance_km, rate_per_km, fixed_fee, transport_expense, earnings, status, notes

type DeliveryRow = {
  id: string;
  user_id: string;
  date_iso: string;
  car_make: string | null;
  car_model: string | null;
  reg: string | null;
  pickup: string | null;
  dropoff: string | null;
  distance_km: number | string | null;
  rate_per_km: number | string | null;
  fixed_fee: number | string | null;
  transport_expense: number | string | null;
  earnings: number | string | null;
  status: 'pending' | 'completed' | 'aborted' | 'cancelled' | null;
  notes: string | null;
};

function rowToDelivery(r: DeliveryRow): Delivery {
  return {
    id: r.id,
    dateISO: r.date_iso,
    carMake: r.car_make || '',
    carModel: r.car_model || '',
    reg: r.reg || '',
    pickup: r.pickup || '',
    dropoff: r.dropoff || '',
    distanceKm: Number(r.distance_km ?? 0),
    ratePerKm: Number(r.rate_per_km ?? 0),
    fixedFee: Number(r.fixed_fee ?? 0),
    transportExpense: Number(r.transport_expense ?? 0),
    earnings: Number(r.earnings ?? 0),
    status: (r.status ?? 'pending') as Delivery['status'],
    notes: r.notes || '',
  };
}
function draftToRow(input: Draft, userId: string, computed: number, id?: string): Partial<DeliveryRow> & { user_id: string } {
  return {
    ...(id ? { id } : {}),
    user_id: userId,
    date_iso: input.dateISO,
    car_make: input.carMake,
    car_model: input.carModel,
    reg: input.reg,
    pickup: input.pickup,
    dropoff: input.dropoff,
    distance_km: Number(input.distanceKm) || 0,
    rate_per_km: Number(input.ratePerKm) || 0,
    fixed_fee: Number(input.fixedFee) || 0,
    transport_expense: Number(input.transportExpense) || 0,
    earnings: computed,
    status: input.status || 'pending',
    notes: input.notes || '',
  } as any;
}

async function fetchDeliveries(userId: string): Promise<Delivery[]> {
  const { data, error } = await supabase
    .from('deliveries')
    .select('*')
    .eq('user_id', userId)
    .order('date_iso', { ascending: false });
  if (error) throw error;
  return (data as DeliveryRow[]).map(rowToDelivery);
}

// -----------------------
// Screen
// -----------------------
export default function Home() {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [query, setQuery] = useState('');
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'week' | 'month' | 'custom'>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [formVisible, setFormVisible] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const [profileVisible, setProfileVisible] = useState(false);
  const [selected, setSelected] = useState<Delivery | null>(null);
  const [jobDetailsVisible, setJobDetailsVisible] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const appState = useRef<AppStateStatus>(AppState.currentState);

  // Initial load (cache first)
  useEffect(() => {
    (async () => {
      const cached = await loadCache();
      if (cached.length) setDeliveries(sortByDateDesc(cached));
    })();
  }, []);

  // Supabase auth + token refresh when app active
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess));

    const subApp = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        supabase.auth.startAutoRefresh();
        syncFromRemote();
      } else {
        supabase.auth.stopAutoRefresh();
      }
      appState.current = state;
    });

    return () => {
      sub.subscription.unsubscribe();
      subApp.remove();
    };
  }, []);

  // Sync when session changes
  useEffect(() => { syncFromRemote(); }, [session?.user?.id]);

  // Realtime subscription
  useEffect(() => {
    if (!session?.user) return;
    const channel = supabase
      .channel(`deliveries-${session.user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries', filter: `user_id=eq.${session.user.id}` }, async () => {
        await syncFromRemote(false); // silent refresh
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session?.user?.id]);

  // --- Sync helper
  async function syncFromRemote(alertOnError = true) {
    try {
      if (!session?.user) return; // no-op when logged out
      const remote = await fetchDeliveries(session.user.id);
      const next = sortByDateDesc(remote);
      setDeliveries(next);
      await saveCache(next);
    } catch (e: any) {
      if (alertOnError) Alert.alert('Sync failed', e?.message ?? 'Please try again later');
      // keep cache
    }
  }

  // -----------------------
  // CRUD
  // -----------------------
  function emptyDraft(): Draft {
    return {
      dateISO: iso(new Date()),
      carMake: '',
      carModel: '',
      reg: '',
      pickup: '',
      dropoff: '',
      distanceKm: 0,
      ratePerKm: 0,
      fixedFee: 0,
      transportExpense: 0,
      earnings: 0,
      status: 'pending',
      notes: '',
    };
  }

  function sortByDateDesc(list: Delivery[]) {
    return [...list].sort((a, b) => (a.dateISO < b.dateISO ? 1 : a.dateISO > b.dateISO ? -1 : 0));
  }

  async function upsertDelivery(input: Draft): Promise<string> {
    const computed = input.earnings && input.earnings > 0
      ? input.earnings
      : (Number(input.distanceKm) || 0) * (Number(input.ratePerKm) || 0) + (Number(input.fixedFee) || 0);

    // If logged in → Supabase is the source of truth
    if (session?.user) {
      const id = input.id ?? uuidv4();
      try {
        const payload = draftToRow(input, session.user.id, computed, input.id ?? id);
        const { data, error } = await supabase
          .from('deliveries')
          .upsert(payload, { onConflict: 'id' })
          .select()
          .single();
        if (error) throw error;
        const saved = rowToDelivery((data as unknown) as DeliveryRow);
        const next = sortByDateDesc([saved, ...deliveries.filter((d) => d.id !== saved.id)]);
        setDeliveries(next);
        await saveCache(next);
        return saved.id;
      } catch (e: any) {
        Alert.alert('Save failed', e?.message ?? 'Unable to save to Supabase');
        // Optimistic local fallback so you don’t lose the entry
        const localId = input.id ?? id;
        const local = { ...(input as Delivery), id: localId, earnings: computed };
        const next = sortByDateDesc([local, ...deliveries.filter((d) => d.id !== localId)]);
        setDeliveries(next);
        await saveCache(next);
        return localId;
      }
    }

    // Logged out → local cache only
    const id = input.id ?? uuidv4();
    const local = { ...(input as Delivery), id, earnings: computed };
    const next = sortByDateDesc([local, ...deliveries.filter((d) => d.id !== id)]);
    setDeliveries(next);
    await saveCache(next);
    return id;
  }

  async function deleteDelivery(id: string) {
    if (session?.user) {
      try {
        const { error } = await supabase.from('deliveries').delete().eq('id', id).eq('user_id', session.user.id);
        if (error) throw error;
      } catch (e: any) {
        Alert.alert('Delete failed', e?.message ?? 'Unable to delete in Supabase');
      }
    }
    const next = deliveries.filter((d) => d.id !== id);
    setDeliveries(next);
    await saveCache(next);
  }

  // -----------------------
  // UI helpers
  // -----------------------
  function openCreate() { setDraft(emptyDraft()); setFormVisible(true); }
  function openEdit(d: Delivery) { setDraft({ ...d }); setFormVisible(true); }
  function openProfile() { setProfileVisible(true); }
  function openJobDetails(d: Delivery) { setSelected(d); setJobDetailsVisible(true); }
  function openDetailsById(id: string) { const d = deliveries.find(x => x.id === id); if (d) openJobDetails(d); }

  function filtered() {
    const q = query.trim().toLowerCase();
    let list = deliveries;
    if (dateFilter === 'today') {
      const todayISO = iso(new Date());
      list = list.filter((d) => d.dateISO === todayISO);
    } else if (dateFilter === 'week') {
      const { startISO, endISO } = getWeekRange(new Date());
      list = list.filter((d) => isWithin(d.dateISO, startISO, endISO));
    } else if (dateFilter === 'month') {
      const now = new Date();
      const startISO = iso(new Date(now.getFullYear(), now.getMonth(), 1));
      const endISO = iso(new Date(now.getFullYear(), now.getMonth() + 1, 0));
      list = list.filter((d) => isWithin(d.dateISO, startISO, endISO));
    } else if (dateFilter === 'custom') {
      if (customFrom && customTo) list = list.filter((d) => isWithin(d.dateISO, customFrom, customTo));
      else if (customFrom) list = list.filter((d) => d.dateISO >= customFrom);
      else if (customTo) list = list.filter((d) => d.dateISO <= customTo);
    }
    if (!q) return list;
    return list.filter((d) => [d.carMake, d.carModel, d.reg, d.pickup, d.dropoff, d.notes].join(' ').toLowerCase().includes(q));
  }

  const totals = useMemo(() => computeTotals(deliveries), [deliveries]);
  const list = filtered();

  // -----------------------
  // Render
  // -----------------------
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar backgroundColor="#0f172a" barStyle="light-content" />
      <View style={styles.container}>
        <Header onProfile={openProfile} totals={totals} />

        <Filters
          query={query}
          setQuery={setQuery}
          dateFilter={dateFilter}
          setDateFilter={setDateFilter}
          customFrom={customFrom}
          customTo={customTo}
          setCustomFrom={setCustomFrom}
          setCustomTo={setCustomTo}
        />

        <FlatList
          data={list}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyTitle}>No deliveries yet</Text>
              <Text style={styles.emptySub}>Tap “+ New” to add your first one.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable style={styles.card} onPress={() => openJobDetails(item)} onLongPress={() => openEdit(item)}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={styles.cardTitle}>{item.carMake} {item.carModel} · {item.reg}</Text>
                <Text >{currency(((Number(item.earnings) || 0) + (Number(item.transportExpense) || 0)))}</Text>
              </View>
              <Text style={styles.cardSub}>{item.dateISO} • {item.pickup} → {item.dropoff} • {item.distanceKm} km</Text>
              <Text style={styles.cardSub}>Gross {currency(item.earnings)} · Exp {currency(item.transportExpense || 0)} · Status: {(item.status || 'pending').toUpperCase()}</Text>
              {item.notes ? <Text style={styles.cardNotes}>{item.notes}</Text> : null}
              <View style={styles.cardActions}>
                <TouchableOpacity onPress={() => openEdit(item)} style={styles.btnGhost}><Text style={styles.btnGhostText}>Edit</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => confirmDelete(item, deleteDelivery)} style={styles.btnGhostDanger}><Text style={styles.btnGhostDangerText}>Delete</Text></TouchableOpacity>
              </View>
            </Pressable>
          )}
          contentContainerStyle={{ paddingBottom: 120 }}
        />

        <StatsBar deliveries={list} />

        {/* was: style={styles.fab} */}
        <TouchableOpacity
          style={[styles.fab, { zIndex: 999 }]}
          onPress={openCreate}
        >
          <Text style={styles.fabText}>＋</Text>
        </TouchableOpacity>


        <DeliveryForm
          visible={formVisible}
          onClose={() => setFormVisible(false)}
          draft={draft}
          setDraft={setDraft}
          // Where you pass onSubmit to <DeliveryForm />
          onSubmit={async () => {
            try {
              if (!draft.dateISO) return Alert.alert('Missing date', 'Please enter a date (YYYY-MM-DD).');
              if (!draft.reg) return Alert.alert('Missing reg', 'Please enter the car registration.');

              const id = await upsertDelivery(draft as Draft);
              setFormVisible(false);
              openDetailsById(id);
            } catch (e: any) {
              Alert.alert('Add delivery failed', e?.message ?? 'Unknown error');
              console.error(e);
            }
          }}

        />

        <ProfileModal visible={profileVisible} onClose={() => setProfileVisible(false)} session={session} />

        <JobDetailsModal
          visible={jobDetailsVisible}
          delivery={selected}
          onClose={() => setJobDetailsVisible(false)}
          onSetStatus={async (s) => {
            if (!selected) return;
            await upsertDelivery({ ...selected, status: s });
            const d = deliveries.find(x => x.id === selected.id);
            if (d) setSelected(d);
          }}
        />
      </View>
    </SafeAreaView>
  );
}

// -----------------------
// Presentational bits reused from your original
// -----------------------
function Header({ onProfile, totals }: { onProfile: () => void; totals: ReturnType<typeof computeTotals> }) {
  return (
    <View style={styles.header}>
      <View>
        <Text style={styles.h1}>Redoo</Text>
        {/* <Text style={styles.h2}>Income (incl. expenses): {currency(totals.net)} · Gross {currency(totals.totalEarnings)} + Exp {currency(totals.totalExpenses)} · {totals.totalJobs} jobs</Text> */}
      </View>
      <TouchableOpacity onPress={onProfile} style={styles.avatar}>
        <Ionicons name="person-circle" size={24} color="white" />
      </TouchableOpacity>
    </View>
  );
}

function Filters({
  query, setQuery,
  dateFilter, setDateFilter,
  customFrom, customTo, setCustomFrom, setCustomTo,
}: {
  query: string; setQuery: (v: string) => void;
  dateFilter: 'all' | 'today' | 'week' | 'month' | 'custom'; setDateFilter: (v: any) => void;
  customFrom: string; customTo: string; setCustomFrom: (v: string) => void; setCustomTo: (v: string) => void;
}) {
  return (
    <View style={styles.filters}>
      <View style={styles.searchWrap}>
        <TextInput
          placeholder="Search (make, model, reg, route...)"
          value={query}
          onChangeText={setQuery}
          style={styles.input}
          autoCapitalize="words"
        />
      </View>
      <View style={styles.chips}>
        {(['today', 'week', 'month', 'all', 'custom'] as const).map((k) => (
          <Pressable key={k} onPress={() => setDateFilter(k)} style={[styles.chip, dateFilter === k && styles.chipActive]}>
            <Text style={[styles.chipText, dateFilter === k && styles.chipTextActive]}>{k.toUpperCase()}</Text>
          </Pressable>
        ))}
      </View>
      {dateFilter === 'custom' && (
        <View style={styles.customRange}>
          <TextInput placeholder="From (YYYY-MM-DD)" value={customFrom} onChangeText={setCustomFrom} style={styles.input} />
          <TextInput placeholder="To (YYYY-MM-DD)" value={customTo} onChangeText={setCustomTo} style={styles.input} />
        </View>
      )}
    </View>
  );
}

function StatsBar({ deliveries }: { deliveries: Delivery[] }) {
  const today = iso(new Date());
  const { startISO, endISO } = getWeekRange(new Date());

  const todayE = sumE(deliveries.filter((d) => d.dateISO === today));
  const todayX = sumX(deliveries.filter((d) => d.dateISO === today));
  const todayIncome = todayE + todayX;

  const weekE = sumE(deliveries.filter((d) => isWithin(d.dateISO, startISO, endISO)));
  const weekX = sumX(deliveries.filter((d) => isWithin(d.dateISO, startISO, endISO)));
  const weekIncome = weekE + weekX;

  const month = new Date();
  const mStart = iso(new Date(month.getFullYear(), month.getMonth(), 1));
  const mEnd = iso(new Date(month.getFullYear(), month.getMonth() + 1, 0));
  const monthE = sumE(deliveries.filter((d) => isWithin(d.dateISO, mStart, mEnd)));
  const monthX = sumX(deliveries.filter((d) => isWithin(d.dateISO, mStart, mEnd)));
  const monthIncome = monthE + monthX;

  const exp = sumX(deliveries);

  return (
    <View style={styles.statsBar} pointerEvents="none">
      <Stat label="Today (Income)" value={currency(todayIncome)} />
      <Stat label="This Week (Income)" value={currency(weekIncome)} />
      <Stat label="This Month (Income)" value={currency(monthIncome)} />
      <Stat label="Expenses" value={currency(exp)} />
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function sumE(list: Delivery[]) { return list.reduce((acc, d) => acc + (Number(d.earnings) || 0), 0); }
function sumX(list: Delivery[]) { return list.reduce((acc, d) => acc + (Number(d.transportExpense) || 0), 0); }

function computeTotals(list: Delivery[]) {
  const totalEarnings = sumE(list);
  const totalExpenses = sumX(list);
  const totalJobs = list.length;
  const totalKm = list.reduce((acc, d) => acc + (Number(d.distanceKm) || 0), 0);
  const net = totalEarnings + totalExpenses; // expenses reimbursed as wages
  const avgPerKm = totalKm > 0 ? net / totalKm : 0;
  return { totalEarnings, totalExpenses, net, totalJobs, totalKm, avgPerKm };
}

function confirmDelete(item: Delivery, onDelete: (id: string) => Promise<void>) {
  Alert.alert('Delete delivery?', `${item.carMake} ${item.carModel} (${item.reg}) on ${item.dateISO}`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => onDelete(item.id) },
  ]);
}

function DeliveryForm({ visible, onClose, draft, setDraft, onSubmit }: {
  visible: boolean;
  onClose: () => void;
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSubmit: () => void | Promise<void>;
}) {
  const set = (k: keyof Draft, v: any) => setDraft({ ...draft, [k]: v });

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{draft.id ? 'Edit Delivery' : 'New Delivery'}</Text>
            <TouchableOpacity onPress={onClose}><Text style={styles.btnGhostText}>Close</Text></TouchableOpacity>
          </View>

          <FlatList
            data={[{ key: 'form' }]}
            keyExtractor={(i) => i.key}
            renderItem={() => (
              <View style={styles.form}>
                <FormRow label="Date (YYYY-MM-DD)">
                  <TextInput
                    placeholder="2025-08-10"
                    value={draft.dateISO}
                    onChangeText={(v) => set('dateISO', v)}
                    style={styles.input}
                  />
                </FormRow>

                <FormRow label="Car Make">
                  <TextInput value={draft.carMake} onChangeText={(v) => set('carMake', v)} style={styles.input} placeholder="Toyota" />
                </FormRow>
                <FormRow label="Car Model">
                  <TextInput value={draft.carModel} onChangeText={(v) => set('carModel', v)} style={styles.input} placeholder="Corolla" />
                </FormRow>
                <FormRow label="Reg Plate">
                  <TextInput value={draft.reg} onChangeText={(v) => set('reg', v)} style={styles.input} placeholder="AB12 CDE" autoCapitalize="characters" />
                </FormRow>

                <FormRow label="Pickup">
                  <TextInput value={draft.pickup} onChangeText={(v) => set('pickup', v)} style={styles.input} placeholder="Wembley" />
                </FormRow>
                <FormRow label="Drop-off">
                  <TextInput value={draft.dropoff} onChangeText={(v) => set('dropoff', v)} style={styles.input} placeholder="Croydon" />
                </FormRow>

                <FormRow label="Distance (km)">
                  <TextInput
                    keyboardType="decimal-pad"
                    value={String(draft.distanceKm ?? '')}
                    onChangeText={(v) => set('distanceKm', Number(v) || 0)}
                    style={styles.input}
                    placeholder="32.5"
                  />
                </FormRow>
                <FormRow label="Rate (£/km)">
                  <TextInput
                    keyboardType="decimal-pad"
                    value={String(draft.ratePerKm ?? '')}
                    onChangeText={(v) => set('ratePerKm', Number(v) || 0)}
                    style={styles.input}
                    placeholder="0.75"
                  />
                </FormRow>
                <FormRow label="Fixed Fee (£)">
                  <TextInput
                    keyboardType="decimal-pad"
                    value={String(draft.fixedFee ?? '')}
                    onChangeText={(v) => set('fixedFee', Number(v) || 0)}
                    style={styles.input}
                    placeholder="10"
                  />
                </FormRow>

                <FormRow label="Transport Expense (£)">
                  <TextInput
                    keyboardType="decimal-pad"
                    value={String(draft.transportExpense ?? '')}
                    onChangeText={(v) => set('transportExpense', Number(v) || 0)}
                    style={styles.input}
                    placeholder="3.50"
                  />
                </FormRow>

                <FormRow label="Earnings (£) — leave blank to auto-calc">
                  <TextInput
                    keyboardType="decimal-pad"
                    value={String(draft.earnings ?? '')}
                    onChangeText={(v) => set('earnings', Number(v) || 0)}
                    style={styles.input}
                    placeholder="(auto)"
                  />
                </FormRow>

                <FormRow label="Notes">
                  <TextInput
                    value={draft.notes}
                    onChangeText={(v) => set('notes', v)}
                    style={[styles.input, { height: 80, textAlignVertical: 'top' }]}
                    multiline
                    placeholder="Any extra details"
                  />
                </FormRow>

                // Inside DeliveryForm (the submit button)
                <TouchableOpacity
                  onPress={async () => {
                    try {
                      await onSubmit();
                    } catch (e: any) {
                      Alert.alert('Save failed', e?.message ?? 'Something went wrong while saving.');
                      console.error(e);
                    }
                  }}
                  style={[styles.btnPrimary, { marginTop: 24 }]}
                >
                  <Text style={styles.btnPrimaryText}>{draft.id ? 'Save Changes' : 'Add Delivery'}</Text>
                </TouchableOpacity>

              </View>
            )}
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.formRow}>
      <Text style={styles.formLabel}>{label}</Text>
      {children}
    </View>
  );
}

// You already have these components in your project; kept inline for completeness
function ProfileModal({ visible, onClose, session }: { visible: boolean; onClose: () => void; session: Session | null }) {
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [website, setWebsite] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');

  useEffect(() => { if (session) getProfile(); }, [session]);

  async function getProfile() {
    try {
      setLoading(true);
      if (!session?.user) throw new Error('No user on the session!');
      const { data, error, status } = await supabase
        .from('profiles')
        .select('username, website, avatar_url')
        .eq('id', session.user.id)
        .single();
      if (error && status !== 406) throw error;
      if (data) {
        setUsername((data as any).username || '');
        setWebsite((data as any).website || '');
        setAvatarUrl((data as any).avatar_url || '');
      }
    } catch (e: any) { Alert.alert(e.message ?? 'Failed to load profile'); }
    finally { setLoading(false); }
  }

  async function updateProfile({ username, website, avatar_url }: { username: string; website: string; avatar_url: string; }) {
    try {
      setLoading(true);
      if (!session?.user) throw new Error('No user on the session!');
      const updates = { id: session.user.id, username, website, avatar_url, updated_at: new Date() };
      const { error } = await supabase.from('profiles').upsert(updates);
      if (error) throw error;
      Alert.alert('Profile saved');
    } catch (e: any) { Alert.alert(e.message ?? 'Failed to update profile'); }
    finally { setLoading(false); }
  }

  async function signIn() {
    try { setLoading(true); const { error } = await supabase.auth.signInWithPassword({ email, password }); if (error) throw error; }
    catch (e: any) { Alert.alert(e.message ?? 'Sign-in failed'); }
    finally { setLoading(false); }
  }
  async function signUp() {
    try { setLoading(true); const { error } = await supabase.auth.signUp({ email, password }); if (error) throw error; Alert.alert('Check your email to confirm your account.'); }
    catch (e: any) { Alert.alert(e.message ?? 'Sign-up failed'); }
    finally { setLoading(false); }
  }
  async function signOut() { await supabase.auth.signOut(); }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Profile</Text>
          <TouchableOpacity onPress={onClose}><Text style={styles.btnGhostText}>Close</Text></TouchableOpacity>
        </View>

        <View style={{ padding: 16, gap: 12, flex: 1,}}>
         
            {!session ? (
              <>
                <Text style={{ color: '#94a3b8' }}>Sign in or create an account</Text>
                <TextInput placeholder="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} style={styles.input} />
                <TextInput placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} style={styles.input} />
                <TouchableOpacity disabled={loading} onPress={signIn} style={styles.btnPrimary}><Text style={styles.btnPrimaryText}>{loading ? 'Loading...' : 'Sign In'}</Text></TouchableOpacity>
                <TouchableOpacity disabled={loading} onPress={signUp} style={styles.btnGhost}><Text style={styles.btnGhostText}>Sign Up</Text></TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={{ color: '#94a3b8' }}>Signed in as {session.user.email}</Text>
                <TextInput placeholder="Username" value={username} onChangeText={setUsername} style={styles.input} />
                <TextInput placeholder="Website" value={website} onChangeText={setWebsite} style={styles.input} />
                <TouchableOpacity disabled={loading} onPress={() => updateProfile({ username, website, avatar_url: avatarUrl })} style={styles.btnPrimary}><Text style={styles.btnPrimaryText}>{loading ? 'Loading ...' : 'Update'}</Text></TouchableOpacity>
                <TouchableOpacity onPress={signOut} style={styles.btnGhostDanger}><Text style={styles.btnGhostDangerText}>Sign Out</Text></TouchableOpacity>
              </>
            )}

            {/* Privacy Policy link */}
            <TouchableOpacity onPress={() => Linking.openURL('https://www.freeprivacypolicy.com/live/ca9ad14a-e9c1-431c-b219-faebbbae4074')} style={{ marginTop: 20 }}>
              <Text style={{ color: '#3b82f6', textDecorationLine: 'underline' }}>Privacy Policy</Text>
            </TouchableOpacity>
         

          {/* App version at the bottom */}
          <Text style={{ color: '#94a3b8', textAlign: 'center', marginTop: 'auto' }}>
            Version {Constants.expoConfig?.version || '1.0.0'}
          </Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
}


function JobDetailsModal({ visible, onClose, delivery, onSetStatus }: { visible: boolean; onClose: () => void; delivery: Delivery | null; onSetStatus: (s: Delivery['status']) => void | Promise<void> }) {
  if (!delivery) return null as any;
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Job Details</Text>
          <TouchableOpacity onPress={onClose}><Text style={styles.btnGhostText}>Close</Text></TouchableOpacity>
        </View>
        <View style={{ padding: 16, gap: 10 }}>
          <Text style={{ color: 'white', fontWeight: '700' }}>{delivery.carMake} {delivery.carModel} · {delivery.reg}</Text>
          <Text style={{ color: '#94a3b8' }}>{delivery.dateISO} • {delivery.pickup} → {delivery.dropoff}</Text>
          <Text style={{ color: '#94a3b8' }}>Gross {currency(delivery.earnings)} · Exp {currency(delivery.transportExpense || 0)} · Income {currency((delivery.earnings || 0) + (delivery.transportExpense || 0))}</Text>
          {delivery.notes ? <Text style={{ color: '#cbd5e1' }}>{delivery.notes}</Text> : null}

          <View style={{ height: 16 }} />
          <Text style={{ color: 'white', fontWeight: '700' }}>Status</Text>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <TouchableOpacity onPress={() => onSetStatus('completed')} style={[styles.btnPrimary]}><Text style={styles.btnPrimaryText}>Mark Completed</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => onSetStatus('aborted')} style={[styles.btnGhost]}><Text style={styles.btnGhostText}>Aborted</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => onSetStatus('cancelled')} style={[styles.btnGhostDanger]}><Text style={styles.btnGhostDangerText}>Cancelled</Text></TouchableOpacity>
          </View>
          <Text style={{ color: '#94a3b8' }}>Current: {delivery.status.toUpperCase()}</Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// -----------------------
// Styles
// -----------------------
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0f172a' },
  container: { flex: 1, padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  h1: { color: 'white', fontSize: 20, fontWeight: '700' },
  h2: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1f2937', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#334155' },
  btnPrimary: { backgroundColor: '#22c55e', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12 },
  btnPrimaryText: { color: '#052e16', fontSize: 14, fontWeight: '700' },
  filters: { backgroundColor: '#0b1220', borderColor: '#1f2937', borderWidth: 1, padding: 12, borderRadius: 16, marginBottom: 12 },
  searchWrap: { marginBottom: 8 },
  input: { backgroundColor: '#0a0f1c', borderColor: '#1f2937', borderWidth: 1, color: 'white', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#334155', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  chipActive: { backgroundColor: '#334155' },
  chipText: { color: '#9ca3af', fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: 'white' },
  customRange: { flexDirection: 'row', gap: 8, marginTop: 8 },
  card: { backgroundColor: '#0b1220', borderColor: '#1f2937', borderWidth: 1, borderRadius: 16, padding: 12, marginBottom: 10 },
  cardTitle: { color: 'white', fontWeight: '700' },
  cardSub: { color: '#94a3b8', marginTop: 4 },
  cardNotes: { color: '#cbd5e1', marginTop: 6 },
  cardActions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  btnGhost: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: '#334155' },
  btnGhostText: { color: '#e5e7eb', fontWeight: '600' },
  btnGhostDanger: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: '#7f1d1d' },
  btnGhostDangerText: { color: '#fecaca', fontWeight: '700' },
  emptyWrap: { alignItems: 'center', paddingVertical: 32 },
  emptyTitle: { color: 'white', fontSize: 16, fontWeight: '700' },
  emptySub: { color: '#94a3b8', marginTop: 6 },
  statsBar: { position: 'absolute', left: 16, right: 16, bottom: 16, backgroundColor: '#0b1220', borderColor: '#1f2937', borderWidth: 1, padding: 12, borderRadius: 16, flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  stat: { flex: 1, alignItems: 'center' },
  statLabel: { color: '#94a3b8', fontSize: 12 },
  statValue: { color: 'white', fontSize: 16, fontWeight: '700', marginTop: 2 },
  modalSafe: { flex: 1, backgroundColor: '#0f172a' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  modalTitle: { color: 'white', fontSize: 18, fontWeight: '700' },
  form: { paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
  formRow: { gap: 6 },
  formLabel: { color: '#9ca3af', fontSize: 12 },
  fab: { position: 'absolute', right: 16, bottom: 92, width: 56, height: 56, borderRadius: 28, backgroundColor: '#22c55e', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, elevation: 6 },
  fabText: { color: '#052e16', fontSize: 28, fontWeight: '900', marginTop: -2 },
});
