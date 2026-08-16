// EXPORTS: ICharacter, MOCK_CHARACTERS

export interface ICharacter {
  id: string;
  name: string;
  avatar: string;
  description: string;
  referenceImages: string[];
  baseModel: string;
  createdAt: string;
  source: 'mock' | 'user';
  // 后端冗余字段（fromSnake 透传，前端目前仅展示/编辑部分）
  gender?: string;
  age?: number;
  tags?: string[];
  style?: Record<string, unknown>;
}

export interface ICharacterStats {
  totalGenerations: number;
  favorites: number;
}

export const MOCK_CHARACTERS: ICharacter[] = [
  {
    id: 'c1',
    name: '示例角色·青鸾',
    avatar: '/spark/app/app_17b6nt94h30/runtime/api/v1/storage/object/bucket_aadknriz7eihs_static/static%2Faadknr7ceouew_ve_miaoda',
    description: '极致舒展的东方骨相，流畅柔和的鹅蛋脸，远山黛眉，桃花眼，气质温婉端庄。适合古风、汉服、古典题材创作。',
    referenceImages: [
      '/spark/app/app_17b6nt94h30/runtime/api/v1/storage/object/bucket_aadknriz7eihs_static/static%2Faadknr7ceouew_ve_miaoda',
      '/spark/app/app_17b6nt94h30/runtime/api/v1/storage/object/bucket_aadknriz7eihs_static/static%2Faadknr6mdrgcu_ve_miaoda',
      '/spark/app/app_17b6nt94h30/runtime/api/v1/storage/object/bucket_aadknriz7eihs_static/static%2Faadknr2aw5iju_ve_miaoda',
    ],
    baseModel: 'Nano Banana Pro',
    createdAt: '2026-07-25T10:00:00Z',
    source: 'mock',
  },
];
