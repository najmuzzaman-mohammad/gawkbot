import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

export interface DataCrumb {
  label: string;
  /** Omit on the last crumb; it renders as plain text. */
  to?: string;
  params?: Record<string, string>;
}

interface DataPageHeaderProps {
  crumbs: readonly DataCrumb[];
  title: string;
  /** Rendered before the title, e.g. the object type icon. */
  icon?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

interface DataCrumbsProps {
  crumbs: readonly DataCrumb[];
}

/**
 * The named trail on its own, for pages whose H1 is not a plain string (the
 * record page's H1 is the record name, editable in place).
 */
export function DataCrumbs({ crumbs }: DataCrumbsProps) {
  return (
    <nav className="data-crumbs" aria-label="Data breadcrumb">
      <ol>
        {crumbs.map((crumb) => (
          <li key={`${crumb.to ?? "current"}-${crumb.label}`}>
            {crumb.to ? (
              <Link to={crumb.to} params={crumb.params}>
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page">{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * Header band shared by every Data screen: a named trail (Data / space /
 * object type), the H1, an optional one-line subtitle, and right-aligned
 * actions. The trail is a real nav landmark of links, never buttons.
 */
export function DataPageHeader({
  crumbs,
  title,
  icon,
  subtitle,
  actions,
}: DataPageHeaderProps) {
  return (
    <header className="data-page-header">
      {/* A one-item trail only repeats the title (the section index). */}
      {crumbs.length > 1 ? <DataCrumbs crumbs={crumbs} /> : null}
      <div className="data-page-header-row">
        <div className="data-page-title-block">
          <h1 className="data-page-title">
            {icon ? <span className="data-page-title-icon">{icon}</span> : null}
            {title}
          </h1>
          {subtitle ? <p className="data-page-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="data-page-actions">{actions}</div> : null}
      </div>
    </header>
  );
}
