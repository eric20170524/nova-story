import React from 'react';

interface SkeletonProps {
  className?: string;
  count?: number;
}

export const Skeleton: React.FC<SkeletonProps> = ({ className = '', count = 1 }) => {
  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className={`animate-pulse bg-slate-800/50 rounded ${className}`}
        />
      ))}
    </>
  );
};

export const CardSkeleton: React.FC = () => (
  <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 h-48 flex flex-col justify-between">
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Skeleton className="w-12 h-12 rounded-lg" />
      </div>
      <Skeleton className="h-6 w-3/4 mb-2" />
      <Skeleton className="h-4 w-full" />
    </div>
    <div className="flex justify-between items-center mt-4">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-3 w-16" />
    </div>
  </div>
);

export const SceneCardSkeleton: React.FC = () => (
  <div className="w-80 flex-shrink-0 flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden h-[28rem]">
    {/* Header */}
    <div className="p-3 border-b border-slate-800 flex justify-between">
      <Skeleton className="h-4 w-16" />
      <Skeleton className="h-4 w-8" />
    </div>
    {/* Image Placeholder */}
    <div className="aspect-square bg-slate-800/30 animate-pulse relative">
        <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-10 h-10 bg-slate-800 rounded-full"></div>
        </div>
    </div>
    {/* Content */}
    <div className="p-3 flex-1 flex flex-col gap-3">
        <div className="flex gap-2">
            <Skeleton className="h-6 flex-1 rounded" />
            <Skeleton className="h-6 flex-1 rounded" />
            <Skeleton className="h-6 flex-1 rounded" />
        </div>
        <div className="space-y-2 flex-1">
            <Skeleton className="h-3 w-10 mb-1" />
            <Skeleton className="h-16 w-full rounded" />
            <Skeleton className="h-3 w-10 mb-1 mt-2" />
            <Skeleton className="h-8 w-full rounded" />
        </div>
    </div>
  </div>
);