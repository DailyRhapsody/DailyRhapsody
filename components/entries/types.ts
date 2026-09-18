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

/** 时间轴用的文章大纲：每篇只带 id、时间、字数和正文开头，不含全文 */
export type EntryOutlineItem = {
  id: string;
  /** publishedAt，缺失时取 date 当天中午（与卡片显示时间同源） */
  at: string;
  words: number;
  /** 正文前 10 个字（超出时以「…」结尾）；纯图片文章没有 */
  excerpt?: string;
  isPublic?: false;
  pinned?: true;
};

/** 时间轴用的动态大纲：每条只带 id、时间、图片/视频数量 */
export type MomentOutlineItem = {
  id: string;
  at: string;
  count: number;
  video?: true;
};

export type Comment = {
  id: string;
  author: string;
  content: string;
  createdAt: string;
  /** 访客头像：头像库编号 */
  avatar?: number;
  /** 站长发的评论 */
  isAuthor?: boolean;
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
