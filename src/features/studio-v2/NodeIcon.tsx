// M05-A/B2 — node icon resolver (registry icon key → lucide component).
import {
  Type,
  Clapperboard,
  ImagePlus,
  Image,
  Film,
  Package,
  Frame,
  User,
  Play,
  Music2,
  LayoutGrid,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  type: Type,
  clapperboard: Clapperboard,
  'image-plus': ImagePlus,
  image: Image,
  film: Film,
  package: Package,
  frame: Frame,
  user: User,
  'clapperboard-image': ImagePlus,
  'film-play': Play,
  audio: Music2,
  storyboard: LayoutGrid,
};

export function NodeIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? Type;
  return <Icon className={className} />;
}
