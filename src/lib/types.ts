export type Member = { id: string; name: string; folder: string };
export type Photo = {
  duplicate?: boolean;
  revision?: string;
  id: string;
  name: string;
  folder: string;
  owner: string;
  width: number;
  height: number;
  bytes: number;
  modifiedAt: string;
  takenAt?: string;
  previewStatus: 'ready' | 'pending' | 'unavailable';
};
export type PhotoList = {
  searchTruncated?: boolean;
  photos: Photo[];
  members: Member[];
  folders: { folder: string; name: string; count: number }[];
  total: number;
  offset: number;
  hasMore: boolean;
  previewService: 'ready' | 'unconfigured' | 'unavailable';
};
