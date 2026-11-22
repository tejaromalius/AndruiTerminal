import React from 'react';

interface PageHeaderProps {
  title: string;
  description: string;
  actions?: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({ title, description, actions }) => (
  <div className="page-header">
    <div className="page-header-copy">
      <h1 className="page-header-title">{title}</h1>
      <p className="page-header-description">{description}</p>
    </div>
    {actions && <div className="page-header-actions">{actions}</div>}
  </div>
);
