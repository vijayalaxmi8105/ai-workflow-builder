'use client';
import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useSubscription } from '@apollo/client/react';
import { useAuth } from '@/lib/auth-context';
import { GET_WORKFLOW_DETAIL, STEP_RUNS_SUBSCRIPTION, APPROVE_STEP } from '@/lib/queries';

type WorkflowStep = { id: string; type: string; step_order: number };
type WorkflowRun = { id: string; status: string; started_at: string; finished_at: string | null };
type StepRun = {
  id: string;
  step_id: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  approved_by: string | null;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
};

const statusColor: Record<string, string> = {
  running: 'text-blue-600',
  paused: 'text-amber-600',
  success: 'text-green-600',
  failed: 'text-red-600',
  pending: 'text-zinc-500',
};

export default function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user, org, loading: authLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && (!user || !org)) {
      router.push('/');
    }
  }, [authLoading, user, org, router]);

  const { data, loading, error } = useQuery<{
    workflows_by_pk: {
      id: string;
      name: string;
      created_at: string;
      workflow_steps: WorkflowStep[];
      workflow_runs: WorkflowRun[];
    } | null;
  }>(GET_WORKFLOW_DETAIL, {
    variables: { workflow_id: id },
    skip: !id,
  });

  const latestRun = data?.workflows_by_pk?.workflow_runs?.[0];

  const { data: subData } = useSubscription<{ step_runs: StepRun[] }>(STEP_RUNS_SUBSCRIPTION, {
    variables: { workflow_run_id: latestRun?.id },
    skip: !latestRun?.id,
  });

  const [approveStep, { loading: approving }] = useMutation(APPROVE_STEP);

  const canApprove = org?.role === 'owner' || org?.role === 'editor';

  async function handleApprove(stepRunId: string) {
    try {
      await approveStep({ variables: { step_run_id: stepRunId } });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to approve step');
    }
  }

  if (authLoading || !org) return null;
  if (loading) return <div className="p-6 text-sm text-zinc-500">Loading...</div>;
  if (error) return <div className="p-6 text-sm text-red-600">Error: {error.message}</div>;

  const workflow = data?.workflows_by_pk;
  if (!workflow) return <div className="p-6 text-sm text-zinc-500">Workflow not found.</div>;

  const stepRuns = subData?.step_runs || [];
  const stepRunByStepId = new Map(stepRuns.map((sr) => [sr.step_id, sr]));

  return (
    <div className="flex-1 bg-zinc-50 dark:bg-black p-6">
      <div className="max-w-3xl mx-auto">
        <button
          onClick={() => router.push('/workflows')}
          className="text-sm text-zinc-500 hover:underline mb-4"
        >
          ← Back to workflows
        </button>
        <h1 className="text-xl font-semibold mb-1">{workflow.name}</h1>
        {latestRun ? (
          <p className={`text-sm mb-6 ${statusColor[latestRun.status] || ''}`}>
            Latest run: {latestRun.status}
          </p>
        ) : (
          <p className="text-sm text-zinc-500 mb-6">No runs yet.</p>
        )}

        <div className="space-y-3">
          {workflow.workflow_steps.map((step) => {
            const run = stepRunByStepId.get(step.id);
            return (
              <div
                key={step.id}
                className="border rounded-lg p-4 bg-white dark:bg-zinc-900 flex items-center justify-between"
              >
                <div>
                  <p className="font-medium">
                    {step.step_order + 1}. {step.type}
                  </p>
                  {run && (
                    <p className={`text-sm ${statusColor[run.status] || ''}`}>
                      {run.status}
                      {run.error ? ` — ${run.error}` : ''}
                    </p>
                  )}
                </div>
                {run?.status === 'paused' && step.type === 'approval_gate' && canApprove && (
                  <button
                    onClick={() => handleApprove(run.id)}
                    disabled={approving}
                    className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    Approve
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
