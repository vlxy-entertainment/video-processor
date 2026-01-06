// Common types used across the application

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

// Video upload related types
export interface VideoUploadRequest {
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface VideoUploadWithFileRequest extends VideoUploadRequest {
  videoId: string;
  file: {
    fieldname: string;
    originalname: string;
    encoding: string;
    mimetype: string;
    destination: string;
    filename: string;
    path: string;
    size: number;
    name: string;
  };
}

export interface VideoUploadResult {
  videoId: string;
  status: 'uploaded';
  success: boolean;
  hlsPlaylistUrl?: string;
  error?: string;
  processingStatus: {
    id: string;
    video_id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: number;
    error?: string;
    created_at: string;
    updated_at: string;
  };
  message: string;
}

// Video metadata types
export interface VideoMetadata {
  id: string;
  name: string;
  originalName: string;
  fileLocation: string;
  size: number;
  mimeType: string;
  duration?: number;
  uploadedAt: Date;
  hlsPlaylistUrl?: string;
}

export interface UploadResponse {
  success: boolean;
  video?: VideoMetadata;
  error?: string;
}

export interface VideoListResponse {
  videos: VideoMetadata[];
  total: number;
}

export interface HLSConversionStatus {
  videoId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  error?: string;
}

export interface TiktokUploadResponse {
  data: {
    uri: string;
    url_list: string[];
    url_prefix: string | null;
  };
  extra: {
    fatal_item_ids: string[];
    logid: string;
    now: number;
  };
  log_pb: {
    impr_id: string;
  };
  status_code: number;
  status_msg: string;
}

// Error types for better type safety
export interface ApiError {
  message: string;
  status?: number;
  statusText?: string;
  data?: unknown;
  config?: {
    url?: string;
    baseURL?: string;
    headers?: Record<string, string>;
  };
}

export interface AxiosError extends Error {
  response?: {
    status: number;
    statusText: string;
    data: unknown;
    headers: Record<string, string>;
  };
  config?: {
    url?: string;
    baseURL?: string;
    headers?: Record<string, string>;
  };
  code?: string;
}

// TikTok Account Management Types
export type TiktokAccountStatus = 'active' | 'limited' | 'inactive';

export interface TiktokAccount {
  id: string;
  name: string;
  sidGuardAds: string;
  aadvid: string;
  status: TiktokAccountStatus;
  csrfToken?: string;
  uploadCount: number;
  lastUploadAt?: Date | undefined;
  cooldownUntil?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTiktokAccountRequest {
  name: string;
  sidGuardAds: string;
  aadvid: string;
  status?: TiktokAccountStatus;
}

export interface UpdateTiktokAccountRequest {
  name?: string;
  sidGuardAds?: string;
  aadvid?: string;
  status?: TiktokAccountStatus;
  uploadCount?: number;
  lastUploadAt?: Date;
  cooldownUntil?: Date;
}

export interface TiktokAccountListResponse {
  accounts: TiktokAccount[];
  total: number;
}
