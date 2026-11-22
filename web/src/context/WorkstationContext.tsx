import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../api/client.js';
import { deduplicateDevices, deviceDedupeKey } from '../lib/devices.js';
import {
  CapabilitiesResponse,
  Device,
  Health,
  Job,
  Operation,
  PageId,
  ThemeId,
  ThemeOption,
} from '../types/api.js';

export const AVAILABLE_THEMES: ThemeOption[] = [
  // Default workbench and emerald light variant
  {
    id: 'emerald',
    name: 'Graphite Workbench (Dark)',
    accent: '#9bbdf2',
    bg: '#16191e',
    description: 'Graphite surfaces with cool blue controls and clear device status (Default)',
    variant: 'dark',
    group: 'emerald',
  },
  {
    id: 'emerald-light',
    name: 'Graphite Workbench (Light)',
    accent: '#2c5ea8',
    bg: '#f5f7fa',
    description: 'Light graphite surfaces with cool blue controls and clear device status',
    variant: 'light',
    group: 'emerald',
  },
  // Midnight Cobalt
  {
    id: 'midnight',
    name: 'Midnight Cobalt (Dark)',
    accent: '#38bdf8',
    bg: '#060b14',
    description: 'Deep space navy blue with electric cyan instrumentation',
    variant: 'dark',
    group: 'midnight',
  },
  {
    id: 'midnight-light',
    name: 'Midnight Cobalt (Light)',
    accent: '#0369a1',
    bg: '#f0f6fc',
    description: 'Glacier azure workstation with deep cobalt and cyan telemetry',
    variant: 'light',
    group: 'midnight',
  },
  // Matrix Terminal
  {
    id: 'matrix',
    name: 'Matrix Terminal (Dark)',
    accent: '#22c55e',
    bg: '#000000',
    description: 'Pure pitch black OLED contrast with phosphor green lines',
    variant: 'dark',
    group: 'matrix',
  },
  {
    id: 'matrix-light',
    name: 'Matrix Terminal (Light)',
    accent: '#15803d',
    bg: '#f3fbf4',
    description: 'Clean mint paper background with matrix monochrome green accents',
    variant: 'light',
    group: 'matrix',
  },
  // Titanium Synthwave
  {
    id: 'purple',
    name: 'Titanium Synthwave (Dark)',
    accent: '#c084fc',
    bg: '#0d0818',
    description: 'Dark obsidian violet with neon magenta and purple telemetry',
    variant: 'dark',
    group: 'purple',
  },
  {
    id: 'purple-light',
    name: 'Titanium Synthwave (Light)',
    accent: '#6d28d9',
    bg: '#faf7fd',
    description: 'Soft lavender workspace with vivid synth violet telemetry',
    variant: 'light',
    group: 'purple',
  },
  // Solar Amber
  {
    id: 'amber',
    name: 'Solar Amber (Dark)',
    accent: '#f59e0b',
    bg: '#120e0a',
    description: 'Warm industrial graphite with monochrome golden amber indicators',
    variant: 'dark',
    group: 'amber',
  },
  {
    id: 'amber-light',
    name: 'Solar Amber (Light)',
    accent: '#b45309',
    bg: '#fefbf5',
    description: 'Warm solar sand paper background with rich amber indicators',
    variant: 'light',
    group: 'amber',
  },
];

interface WorkstationContextType {
  // Navigation
  activePage: PageId;
  setActivePage: (page: PageId) => void;

  // Devices
  devices: Device[];
  selectedDeviceId: string | null;
  selectedDevice: Device | null;
  setSelectedDeviceId: (id: string | null) => void;
  refreshDevices: () => Promise<void>;
  devicesLoading: boolean;
  devicesError: string | null;

  // Operations
  operations: Operation[];
  operationsLoading: boolean;
  operationsError: string | null;
  refreshOperations: () => Promise<void>;
  findOperation: (idOrCoverage: string) => Operation | undefined;

  // Capabilities & Health
  capabilities: CapabilitiesResponse | null;
  health: Health | null;
  refreshCapabilities: () => Promise<void>;
  isWsConnected: boolean;

  // Jobs
  jobs: Job[];
  activeJobs: Job[];
  totalJobs: number;
  loadMoreJobs: () => Promise<void>;
  isLoadingMoreJobs: boolean;
  hasMoreJobs: boolean;
  selectedJobId: string | null;
  setSelectedJobId: (id: string | null) => void;
  selectedJob: Job | null;
  refreshJobs: () => Promise<void>;
  isJobDrawerOpen: boolean;
  setIsJobDrawerOpen: (open: boolean) => void;
  isAiDrawerOpen: boolean;
  setIsAiDrawerOpen: (open: boolean) => void;
  isArtifactDrawerOpen: boolean;
  setIsArtifactDrawerOpen: (open: boolean) => void;
  runOperation: (
    operationId: string,
    params?: Record<string, unknown>,
    confirmed?: boolean,
    options?: { showDrawer?: boolean }
  ) => Promise<Job>;
  cancelJob: (id: string) => Promise<void>;

  // Operation Modal
  activeModalOperation: Operation | null;
  modalDefaultParams: Record<string, unknown>;
  openOperationModal: (operation: Operation, defaultParams?: Record<string, unknown>) => void;
  closeOperationModal: () => void;

  // Command Palette
  isCommandPaletteOpen: boolean;
  setIsCommandPaletteOpen: (open: boolean) => void;

  // Mobile Navigation
  isMobileNavOpen: boolean;
  setIsMobileNavOpen: (open: boolean) => void;

  // Theme Selection
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  availableThemes: ThemeOption[];
}

const WorkstationContext = createContext<WorkstationContextType | null>(null);

export const WorkstationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activePage, setActivePage] = useState<PageId>('overview');

  // Devices
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(() => {
    return localStorage.getItem('andrui_selected_device') || null;
  });
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);

  // Operations
  const [operations, setOperations] = useState<Operation[]>([]);
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [operationsError, setOperationsError] = useState<string | null>(null);

  // Capabilities & Health
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [isWsConnected, setIsWsConnected] = useState(false);

  // Jobs
  const [jobs, setJobs] = useState<Job[]>([]);
  const [totalJobs, setTotalJobs] = useState<number>(0);
  const [isLoadingMoreJobs, setIsLoadingMoreJobs] = useState<boolean>(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [isJobDrawerOpen, setIsJobDrawerOpenState] = useState(false);
  const [isAiDrawerOpen, setIsAiDrawerOpenState] = useState(false);
  const [isArtifactDrawerOpen, setIsArtifactDrawerOpenState] = useState(false);

  // Bottom panels share one dock; opening one closes the others.
  const setIsJobDrawerOpen = useCallback((open: boolean) => {
    setIsJobDrawerOpenState(open);
    if (open) { setIsAiDrawerOpenState(false); setIsArtifactDrawerOpenState(false); }
  }, []);

  const setIsAiDrawerOpen = useCallback((open: boolean) => {
    setIsAiDrawerOpenState(open);
    if (open) { setIsJobDrawerOpenState(false); setIsArtifactDrawerOpenState(false); }
  }, []);

  const setIsArtifactDrawerOpen = useCallback((open: boolean) => {
    setIsArtifactDrawerOpenState(open);
    if (open) { setIsJobDrawerOpenState(false); setIsAiDrawerOpenState(false); }
  }, []);

  // Modals
  const [activeModalOperation, setActiveModalOperation] = useState<Operation | null>(null);
  const [modalDefaultParams, setModalDefaultParams] = useState<Record<string, unknown>>({});
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);

  // Theme state with local persistence
  const [theme, setThemeState] = useState<ThemeId>(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      return (localStorage.getItem('andrui_theme') as ThemeId) || 'emerald';
    }
    return 'emerald';
  });

  const setTheme = useCallback((newTheme: ThemeId) => {
    setThemeState(newTheme);
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem('andrui_theme', newTheme);
    }
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', newTheme);
    }
  }, []);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  // Device selection persistence
  const selectionRef = React.useRef(selectedDeviceId);
  const handleSelectDevice = useCallback((id: string | null) => {
    selectionRef.current = id;
    setSelectedDeviceId(id);
    if (id) {
      localStorage.setItem('andrui_selected_device', id);
    } else {
      localStorage.removeItem('andrui_selected_device');
    }
  }, []);

  const selectedDevice = useMemo(() => {
    if (!selectedDeviceId) return null;
    return devices.find((d) => d.id === selectedDeviceId) || null;
  }, [devices, selectedDeviceId]);

  // Preserve an explicit target across disconnects; never switch to another device.
  useEffect(() => {
    if (devices.length > 0 && !selectionRef.current) handleSelectDevice(devices[0].id);
  }, [devices, selectedDeviceId, handleSelectDevice]);

  // Fetch functions
  const refreshDevices = useCallback(async () => {
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const rawData = await api.getDevices();
      const data = deduplicateDevices(rawData);
      const currentSelected = selectionRef.current;
      if (currentSelected && !data.some((d) => d.id === currentSelected)) {
        const rawMatch = rawData.find((d) => d.id === currentSelected);
        if (rawMatch) {
          const replacement = data.find(
            (d) => deviceDedupeKey(d) === deviceDedupeKey(rawMatch)
          );
          if (replacement) {
            handleSelectDevice(replacement.id);
          }
        }
      }
      setDevices(data);
    } catch (err: unknown) {
      setDevicesError(err instanceof Error ? err.message : 'Failed to fetch devices');
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  const refreshOperations = useCallback(async () => {
    setOperationsLoading(true);
    setOperationsError(null);
    try {
      const data = await api.getOperations();
      setOperations(data);
    } catch (err: unknown) {
      setOperationsError(err instanceof Error ? err.message : 'Failed to fetch operations');
    } finally {
      setOperationsLoading(false);
    }
  }, []);

  const refreshCapabilities = useCallback(async () => {
    try {
      const [caps, hlth] = await Promise.allSettled([
        api.getCapabilities(),
        api.getHealth(),
      ]);
      if (caps.status === 'fulfilled') setCapabilities(caps.value);
      if (hlth.status === 'fulfilled') setHealth(hlth.value);
    } catch (err) {
      console.error('Capabilities/Health fetch error:', err);
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await api.getJobs({ limit: 50, offset: 0 });
      setJobs(Array.isArray(res?.jobs) ? res.jobs : []);
      setTotalJobs(typeof res?.total === 'number' ? res.total : 0);
    } catch (err) {
      console.error('Jobs fetch error:', err);
    }
  }, []);

  const loadMoreJobs = useCallback(async () => {
    if (isLoadingMoreJobs) return;
    if (totalJobs > 0 && jobs.length >= totalJobs) return;
    setIsLoadingMoreJobs(true);
    try {
      const res = await api.getJobs({ limit: 50, offset: jobs.length });
      const newJobs = Array.isArray(res?.jobs) ? res.jobs : [];
      if (typeof res?.total === 'number') {
        setTotalJobs(res.total);
      }
      setJobs((prev) => {
        const existing = new Set(prev.map((j) => j.id));
        const older = newJobs.filter((j) => !existing.has(j.id));
        return [...prev, ...older];
      });
    } catch (err) {
      console.error('Load more jobs error:', err);
    } finally {
      setIsLoadingMoreJobs(false);
    }
  }, [jobs.length, totalJobs, isLoadingMoreJobs]);

  const hasMoreJobs = totalJobs > jobs.length;

  // Operation helper
  const findOperation = useCallback(
    (idOrCoverage: string): Operation | undefined => {
      return operations.find(
        (op) =>
          op.id === idOrCoverage ||
          (op.coverageIds && op.coverageIds.includes(idOrCoverage))
      );
    },
    [operations]
  );

  // Run operation
  const runOperation = useCallback(
    async (
      operationId: string,
      params: Record<string, unknown> = {},
      confirmed = false,
      options?: { showDrawer?: boolean }
    ): Promise<Job> => {
      const op = operations.find((o) => o.id === operationId);
      const targetDevice = op?.requiresDevice ? selectedDeviceId || undefined : undefined;

      const job = await api.createJob(operationId, targetDevice, params, confirmed);
      setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      setTotalJobs((c) => Math.max(c + 1, jobs.length + 1));
      setSelectedJobId(job.id);
      if (options?.showDrawer === true) {
        setIsJobDrawerOpen(true);
      }
      return job;
    },
    [operations, selectedDeviceId]
  );

  const cancelJob = useCallback(async (id: string) => {
    const updated = await api.cancelJob(id);
    setJobs((prev) => prev.map((j) => (j.id === id ? updated : j)));
  }, []);

  // Modal helper
  const openOperationModal = useCallback(
    (operation: Operation, defaultParams: Record<string, unknown> = {}) => {
      setActiveModalOperation(operation);
      setModalDefaultParams(defaultParams);
    },
    []
  );

  const closeOperationModal = useCallback(() => {
    setActiveModalOperation(null);
    setModalDefaultParams({});
  }, []);

  // Selected & active jobs
  const activeJobs = useMemo(
    () => jobs.filter((j) => j.status === 'queued' || j.status === 'running'),
    [jobs]
  );

  const selectedJob = useMemo(
    () => (selectedJobId ? jobs.find((j) => j.id === selectedJobId) || null : null),
    [jobs, selectedJobId]
  );

  // Initial Load
  useEffect(() => {
    refreshDevices();
    refreshOperations();
    refreshCapabilities();
    refreshJobs();
  }, [refreshDevices, refreshOperations, refreshCapabilities, refreshJobs]);

  // WebSocket Live Events
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let delay = 1000;
    let isDisposed = false;

    const connectWs = async () => {
      if (isDisposed) return;
      try {
        await api.getSession();
        if (isDisposed) return;
        const url = api.getEventsWebSocketUrl();
        ws = new WebSocket(url);

        ws.onopen = () => {
          setIsWsConnected(true);
          delay = 1000;
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'device' || data.type === 'devices') {
              refreshDevices();
            } else if ((data.type === 'job' && data.job) || ((data.type === 'job_created' || data.type === 'job_updated') && data.data)) {
              const updatedJob: Job = data.job || data.data;
              setJobs((prev) => {
                const idx = prev.findIndex((j) => j.id === updatedJob.id);
                if (idx >= 0) {
                  const next = [...prev];
                  next[idx] = updatedJob;
                  return next;
                }
                setTotalJobs((c) => Math.max(c + 1, prev.length + 1));
                return [updatedJob, ...prev];
              });
              if (
                updatedJob.status === 'completed' &&
                ['device.connect', 'device.disconnect', 'device.reconnect', 'device.usb', 'device.tcpip'].includes(
                  updatedJob.operationId
                )
              ) {
                refreshDevices();
              }
            } else if (data.type === 'approval' && data.data) {
              window.dispatchEvent(new CustomEvent('andrui:approval', { detail: data.data }));
            } else if (data.type === 'artifact_created' && data.data) {
              window.dispatchEvent(new CustomEvent('andrui:artifact', { detail: data.data }));
              window.dispatchEvent(new Event('andrui:artifacts-changed'));
            } else {
              // General trigger
              refreshJobs();
              refreshDevices();
            }
          } catch {
            // Ignore parse errors on raw notifications
          }
        };

        ws.onclose = () => {
          setIsWsConnected(false);
          if (!isDisposed) {
            reconnectTimeout = setTimeout(() => {
              delay = Math.min(delay * 1.5, 15000);
              connectWs();
            }, delay);
          }
        };

        ws.onerror = () => {
          setIsWsConnected(false);
          ws?.close();
        };
      } catch (err) {
        setIsWsConnected(false);
        if (!isDisposed) {
          reconnectTimeout = setTimeout(connectWs, 5000);
        }
      }
    };

    connectWs();

    return () => {
      isDisposed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [refreshDevices, refreshJobs]);

  // Keyboard shortcut for Command Palette (Ctrl+K or Cmd+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <WorkstationContext.Provider
      value={{
        activePage,
        setActivePage,
        devices,
        selectedDeviceId,
        selectedDevice,
        setSelectedDeviceId: handleSelectDevice,
        refreshDevices,
        devicesLoading,
        devicesError,
        operations,
        operationsLoading,
        operationsError,
        refreshOperations,
        findOperation,
        capabilities,
        health,
        refreshCapabilities,
        isWsConnected,
        jobs,
        activeJobs,
        totalJobs,
        loadMoreJobs,
        isLoadingMoreJobs,
        hasMoreJobs,
        selectedJobId,
        setSelectedJobId,
        selectedJob,
        refreshJobs,
        isJobDrawerOpen,
        setIsJobDrawerOpen,
        isAiDrawerOpen,
        setIsAiDrawerOpen,
        isArtifactDrawerOpen,
        setIsArtifactDrawerOpen,
        runOperation,
        cancelJob,
        activeModalOperation,
        modalDefaultParams,
        openOperationModal,
        closeOperationModal,
        isCommandPaletteOpen,
        setIsCommandPaletteOpen,
        isMobileNavOpen,
        setIsMobileNavOpen,
        theme,
        setTheme,
        availableThemes: AVAILABLE_THEMES,
      }}
    >
      {children}
    </WorkstationContext.Provider>
  );
};

export const useWorkstation = (): WorkstationContextType => {
  const context = useContext(WorkstationContext);
  if (!context) {
    throw new Error('useWorkstation must be used within a WorkstationProvider');
  }
  return context;
};
