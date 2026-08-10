'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation } from '@apollo/client/react';
import { useAuth } from '@/lib/auth-context';
import { GET_ORG_WORKFLOWS, TRIGGER_WORKFLOW_RUN } from '@/lib/queries';

type Step = { id: string; type: string; step_order: number };
type Trigger = { id: string; type: string };
type Run = { id: string; status: string; started_at: string };
type Workflow = {
  id: string;
  name: string;
  created_at: string;
  workflow_steps: Step[];
  workflow_triggers: Trigger[];
  workflow_runs: Run[];
};

const statusColor: Record<string, string> = {
  running: 'text-blue-600',
  paused: 'text-amber-600',
  completed: 'text-green-600',
  failed: 'text-red-600',
  pending: 'text-zinc-500',
};

export default function WorkflowsPage() {
  const { user, org, loading, logout, availableOrgs, switchOrg } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && (!user || !org)) {
      router.push('/');
    }
  }, [loading, user, org, router]);

  const { data, loading: queryLoading, error, refetch } = useQuery<{ workflows: Workflow[]; organizations_by_pk: { quota_calls_used: number; quota_calls_allowed: number } | null }>(GET_ORG_WORKFLOWS, {
    variables: { org_id: org?.id },
    skip: !org,
    pollInterval: 5000,
  });

  const [triggerRun, { loading: triggering }] = useMutation(TRIGGER_WORKFLOW_RUN);

  async function handleRun(workflowId: string) {
    try {
      await triggerRun({ variables: { workflow_id: workflowId } });
      refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to trigger run');
    }
  }

  if (loading || !org) return null;

  const orgData = data?.organizations_by_pk;
  const workflows: Workflow[] = data?.workflows || [];
  const canRun = org.role === 'owner' || org.role === 'editor';

  return (
    <div className="flex-1 bg-zinc-50 dark:bg-black p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold">Workflows</h1>
            <p className="text-sm text-zinc-500">
              {user?.email} · {org.name} · <span className="uppercase">{org.role}</span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {availableOrgs.length > 1 && (
              <select
                value={org.id}
                onChange={(e) => switchOrg(e.target.value)}
                className="text-sm border border-zinc-300 dark:border-zinc-700 rounded-md px-2 py-1 bg-transparent"
              >
                {availableOrgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} ({o.role})
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={() => {
                logout();
                router.push('/');
              }}
              className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              Sign out
            </button>
          </div>
        </div>

        {orgData && (
          <div className="mb-6 p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="font-medium">Usage this period</span>
              <span className="text-zinc-500">
                {orgData.quota_calls_used} / {orgData.quota_calls_allowed} calls
              </span>
            </div>
            <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-zinc-900 dark:bg-zinc-100"
                style={{
                  width: `${Math.min(100, (orgData.quota_calls_used / orgData.quota_calls_allowed) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-600 mb-4">Error loading workflows: {error.message}</p>}
        {queryLoading && !data && <p className="text-sm text-zinc-500">Loading...</p>}

        <div className="flex flex-col gap-3">
          {workflows.map((wf) => {
            const lastRun = wf.workflow_runs[0];
            return (
              <div
                key={wf.id}
                className="p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex items-center justify-between"
              >
                <div>
                  <button
                    onClick={() => router.push(`/workflows/${wf.id}`)}
                    className="font-medium hover:underline"
                  >
                    {wf.name}
                  </button>
                  <p className="text-xs text-zinc-500 mt-1">
                    {wf.workflow_steps.length} step{wf.workflow_steps.length !== 1 ? 's' : ''} ·{' '}
                    {wf.workflow_triggers.map((t) => t.type).join(', ') || 'no trigger'}
                    {lastRun && (
                      <>
                        {' '}
                        · last run:{' '}
                        <span className={statusColor[lastRun.status] || ''}>{lastRun.status}</span>
                      </>
                    )}
                  </p>
                </div>
                {canRun && (
                  <button
                    onClick={() => handleRun(wf.id)}
                    disabled={triggering}
                    className="text-sm bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-md px-4 py-1.5 disabled:opacity-50"
                  >
                    {triggering ? 'Starting...' : 'Run'}
                  </button>
                )}
              </div>
            );
          })}
          {!queryLoading && workflows.length === 0 && (
            <p className="text-sm text-zinc-500">No workflows yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
