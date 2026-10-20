import { ReactNode } from 'react';
import { PageHeader } from './ui';

interface PageProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}

export function Page({ title, description, children }: PageProps) {
  return (
    <div className="p-5 md:p-8">
      <PageHeader title={title} description={description} />
      <div>{children}</div>
    </div>
  );
}