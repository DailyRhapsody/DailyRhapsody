export type Diary = {
  id: string;
  date: string;
  publishedAt?: string;
  isPublic?: boolean;
  summary: string;
  location?: string;
  tags?: string[];
  images?: string[];
};

/** 时间轴用的文章大纲：每篇只带 id、时间和字数，不含正文 */
export type EntryOutlineItem = {
  id: string;
  /** publishedAt，缺失时取 date 当天中午（与卡片显示时间同源） */
  at: string;
  words: number;
  isPublic?: false;
  pinned?: true;
};

export type Comment = {
  id: string;
  author: string;
  content: string;
  createdAt: string;
};

export type PublicMedia = {
  url: string;
  thumbUrl: string;
  mediaType: string;
  width: number;
  height: number;
  duration: number;
  sortOrder: number;
};

export type PublicMoment = {
  id: number;
  type: 1 | 2;
  createdAt: string;
  media: PublicMedia[];
};

export type MomentsTimelineRow = {
  rowKey: string;
  createdAt: string;
  moment: PublicMoment;
};

export type GalleryTimelineRow = MomentsTimelineRow;
