// Inline SVG icons for websites. Nothing is fetched and no icon font is shipped.
import * as React from "react";
import {
  ArrowRight, ArrowUpRight, Baby, Bath, BadgeCheck, BarChart3, Bed, Briefcase, Brush, Building2, Calendar, CalendarCheck, Camera, Car, Check, Clock, Code, Coffee,
  Compass, Cpu, Droplets, Dumbbell, FileText, Flame, Flower2, Gem, Globe, Hammer, Handshake, Heart, House, Key, Layers, Leaf, Lightbulb, Lock, Mail, MapPin,
  MessageCircle, Monitor, Mountain, Palette, PawPrint, PenTool, Phone, Play, Quote, Rocket, Ruler, Scale, Scissors, Search, Shield, Smile, Snowflake, Sofa, Sparkles,
  Sprout, Star, Stethoscope, Sun, Target, ThumbsUp, TrendingUp, Trees, Truck, Users, Utensils, Waves, Wifi, Wine, Wrench, Zap, Paintbrush, type LucideIcon,
} from "lucide-react";
import type { IconName } from "@/lib/website/catalog";

const MAP: Record<IconName, LucideIcon> = {
  wrench: Wrench, home: House, heart: Heart, shield: Shield, clock: Clock, star: Star, "map-pin": MapPin, phone: Phone, mail: Mail, calendar: Calendar, check: Check,
  sparkles: Sparkles, users: Users, briefcase: Briefcase, hammer: Hammer, leaf: Leaf, zap: Zap, droplets: Droplets, key: Key, stethoscope: Stethoscope, smile: Smile,
  scale: Scale, chart: BarChart3, building: Building2, truck: Truck, paintbrush: Paintbrush, camera: Camera, lightbulb: Lightbulb, "thumbs-up": ThumbsUp, "file-text": FileText,
  "arrow-right": ArrowRight, "arrow-up-right": ArrowUpRight, play: Play, quote: Quote, bed: Bed, bath: Bath, ruler: Ruler, sun: Sun, waves: Waves, coffee: Coffee,
  utensils: Utensils, wine: Wine, dumbbell: Dumbbell, flower: Flower2, cpu: Cpu, code: Code, rocket: Rocket, globe: Globe, lock: Lock, layers: Layers, target: Target,
  "trending-up": TrendingUp, "badge-check": BadgeCheck, "calendar-check": CalendarCheck, car: Car, sofa: Sofa, trees: Trees, mountain: Mountain, compass: Compass, gem: Gem,
  handshake: Handshake, "message-circle": MessageCircle, search: Search, "pen-tool": PenTool, scissors: Scissors, baby: Baby, "paw-print": PawPrint, sprout: Sprout,
  flame: Flame, snowflake: Snowflake, wifi: Wifi, monitor: Monitor, palette: Palette, brush: Brush,
};

export function Icon({ name, className, strokeWidth = 1.6 }: { name: string; className?: string; strokeWidth?: number }) {
  const Cmp = MAP[name as IconName] ?? Sparkles;
  return <Cmp className={className} aria-hidden strokeWidth={strokeWidth} />;
}

/** Simple, original glyphs for the social networks. */
export function SocialIcon({ network, className }: { network: "facebook" | "instagram" | "linkedin" | "x" | "youtube" | "tiktok"; className?: string }) {
  const common = { className, viewBox: "0 0 24 24", "aria-hidden": true, fill: "currentColor" } as const;
  switch (network) {
    case "facebook": return <svg {...common}><path d="M13.5 21v-8h2.7l.5-3.2h-3.2V7.9c0-.9.4-1.7 1.8-1.7h1.5V3.4S15.5 3 14.2 3C11.6 3 9.9 4.6 9.9 7.4v2.4H7.2V13h2.7v8h3.6Z" /></svg>;
    case "instagram": return <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3.5" y="3.5" width="17" height="17" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none" /></svg>;
    case "linkedin": return <svg {...common}><path d="M6.2 9.4H3.3V20h2.9V9.4ZM4.8 4a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4ZM20.7 20v-5.8c0-2.8-.6-4.9-3.9-4.9-1.6 0-2.6.9-3.1 1.700h0V9.4H10.800V20h2.900v-5.300c0-1.400.3-2.800 2-2.800 1.800 0 1.800 1.600 1.800 2.900V20h3.200Z" /></svg>;
    case "x": return <svg {...common}><path d="M17.8 3h3.1l-6.800 7.800L22 21h-6.200l-4.900-6.400L5.300 21H2.200l7.300-8.300L2 3h6.400l4.400 5.800L17.800 3Zm-1.100 16.200h1.700L7.400 4.700H5.600l11.100 14.500Z" /></svg>;
    case "youtube": return <svg {...common}><path d="M21.600 7.200a2.500 2.500 0 0 0-1.800-1.800C18.200 5 12 5 12 5s-6.200 0-7.800.4A2.500 2.500 0 0 0 2.400 7.200C2 8.800 2 12 2 12s0 3.200.4 4.800a2.500 2.500 0 0 0 1.800 1.800C5.800 19 12 19 12 19s6.200 0 7.800-.4a2.500 2.500 0 0 0 1.800-1.800c.4-1.600.4-4.800.4-4.800s0-3.200-.4-4.800ZM10 15V9l5.200 3L10 15Z" /></svg>;
    case "tiktok": return <svg {...common}><path d="M16.600 3h-3v12.200a2.600 2.600 0 1 1-2.600-2.600c.3 0 .5 0 .8.100V9.600a5.700 5.700 0 1 0 4.800 5.600V9a7 7 0 0 0 4 1.300V7.300a4 4 0 0 1-4-4.300Z" /></svg>;
  }
}
