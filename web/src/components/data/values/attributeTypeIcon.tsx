import type { ComponentType, SVGProps } from "react";
import {
  AtSign,
  Box,
  Building,
  Calendar,
  ChatBubble,
  CheckCircle,
  CheckSquare,
  Dollar,
  Folder,
  Globe,
  Hashtag,
  HelpCircle,
  Label,
  Link,
  List,
  Mail,
  Network,
  Page,
  Phone,
  Star,
  StatsUpSquare,
  Suitcase,
  Text,
  TriangleFlag,
  User,
} from "iconoir-react";

import type { AttributeType } from "../../../api/dataspaces";

export type DataIconComponent = ComponentType<SVGProps<SVGSVGElement>>;

const ATTRIBUTE_TYPE_ICONS: Readonly<Record<AttributeType, DataIconComponent>> =
  {
    text: Text,
    number: Hashtag,
    currency: Dollar,
    date: Calendar,
    toggle: CheckSquare,
    select: List,
    status: StatsUpSquare,
    rating: Star,
    url: Link,
    email: AtSign,
    phone: Phone,
    relationship: Network,
  };

/** Shown for an attribute type this bundle does not know. */
const FALLBACK_ATTRIBUTE_TYPE_ICON: DataIconComponent = HelpCircle;

/**
 * Widened to `string` for the same reason the value renderers are: the map
 * stays exhaustive over the union, and a type the server added after this
 * bundle shipped resolves to a question mark rather than to `undefined`,
 * which React renders as a thrown "Element type is invalid".
 */
const ICONS_BY_TYPE: Readonly<Record<string, DataIconComponent | undefined>> =
  ATTRIBUTE_TYPE_ICONS;

export function attributeTypeIcon(type: string): DataIconComponent {
  return ICONS_BY_TYPE[type] ?? FALLBACK_ATTRIBUTE_TYPE_ICON;
}

export interface AttributeTypeIconProps {
  type: AttributeType;
  className?: string;
}

/** Decorative: always pair it with the type's text label. */
export function AttributeTypeIcon({ type, className }: AttributeTypeIconProps) {
  const Icon = attributeTypeIcon(type);
  return (
    <Icon
      className={className ? `dv-type-icon ${className}` : "dv-type-icon"}
      aria-hidden="true"
      focusable="false"
    />
  );
}

const OBJECT_TYPE_ICONS = {
  user: User,
  building: Building,
  calendar: Calendar,
  briefcase: Suitcase,
  folder: Folder,
  "check-circle": CheckCircle,
  star: Star,
  dollar: Dollar,
  mail: Mail,
  phone: Phone,
  globe: Globe,
  box: Box,
  flag: TriangleFlag,
  chat: ChatBubble,
  doc: Page,
  tag: Label,
} as const satisfies Readonly<Record<string, DataIconComponent>>;

export type ObjectTypeIconKey = keyof typeof OBJECT_TYPE_ICONS;

/** The keys an icon picker should offer, in display order. */
export const OBJECT_TYPE_ICON_KEYS = Object.keys(
  OBJECT_TYPE_ICONS,
) as readonly ObjectTypeIconKey[];

const FALLBACK_OBJECT_TYPE_ICON: DataIconComponent = Box;

function isObjectTypeIconKey(key: string): key is ObjectTypeIconKey {
  return Object.hasOwn(OBJECT_TYPE_ICONS, key);
}

/**
 * Resolves `ObjectType.icon`. Bots write that key, so an unknown or empty one
 * falls back to a neutral box rather than rendering nothing.
 */
export function objectTypeIcon(key: string): DataIconComponent {
  const normalized = key.trim().toLowerCase();
  return isObjectTypeIconKey(normalized)
    ? OBJECT_TYPE_ICONS[normalized]
    : FALLBACK_OBJECT_TYPE_ICON;
}
