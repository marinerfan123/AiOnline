// M05-A — node icon resolver (registry icon key → lucide component).
import {
  Type,
  Clapperboard,
  ImagePlus,
  Image,
  Film,
  Package,
  Frame,
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
};

export function NodeIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? Type;
  return <Icon className={className} />;
}
