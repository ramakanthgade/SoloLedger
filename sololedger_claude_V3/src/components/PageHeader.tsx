import type { ReactNode } from 'react';

type PageHeaderProps = {
  title: string;
  subtitle?: ReactNode;
};

export function PageHeader({ title, subtitle }: PageHeaderProps) {
  return (
    <div className="mb-8">
      <h2 className="page-title">{title}</h2>
      {subtitle && <p className="page-subtitle">{subtitle}</p>}
    </div>
  );
}
