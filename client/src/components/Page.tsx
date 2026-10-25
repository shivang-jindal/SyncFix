import type { ReactNode } from 'react';

import { PageHeader } from './ui';

interface PageProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  children: ReactNode;
}

export function Page({ title, description, actions, breadcrumb, children }: PageProps) {
  return (
    <div className="p-5 md:p-8">
      <PageHeader
        title={title}
        description={description}
        {...(actions ? { actions } : {})}
        {...(breadcrumb ? { breadcrumb } : {})}
      />
      <div>{children}</div>
    </div>
  );
}
