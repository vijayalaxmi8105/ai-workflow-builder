const express = require('express');
console.log("fetch check at startup:", typeof globalThis.fetch);
require('dotenv').config();

const app = express();
app.use(express.json());

const HASURA_URL = process.env.HASURA_GRAPHQL_URL;
const ADMIN_SECRET = process.env.HASURA_ADMIN_SECRET;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

async function gql(query, variables) {
  const res = await globalThis.fetch(HASURA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hasura-Admin-Secret': ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error('GraphQL errors:', JSON.stringify(json.errors));
    throw new Error(JSON.stringify(json.errors));
  }
  return json.data;
}

async function callLLM(prompt) {
  const res = await globalThis.fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.choices[0].message.content;
}

async function retryable(fn, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.log(`Attempt ${i + 1} failed:`, err.message);
    }
  }
  throw lastErr;
}

async function executeStep(step, previousOutput) {
  const config = step.config || {};
  switch (step.type) {
    case 'llm_call': {
      const prompt = (config.prompt || 'Say hello') + (previousOutput ? `\nPrevious step output: ${JSON.stringify(previousOutput)}` : '');
      const result = await retryable(() => callLLM(prompt));
      return { output: result };
    }
    case 'http_request': {
      const url = config.url || 'https://official-joke-api.appspot.com/random_joke';
      const result = await retryable(async () => {
        const res = await globalThis.fetch(url);
        return res.json();
      });
      return { output: result };
    }
    case 'db_write': {
      return { output: { saved: true, data: previousOutput } };
    }
    case 'notify': {
      console.log('NOTIFY:', config.message || 'Workflow event', previousOutput);
      return { output: { notified: true } };
    }
    case 'conditional_branch': {
      const text = JSON.stringify(previousOutput || {}).toLowerCase();
      const keyword = (config.keyword || 'yes').toLowerCase();
      const branch = text.includes(keyword) ? 'true_branch' : 'false_branch';
      return { output: { branch } };
    }
    case 'approval_gate': {
      return { paused: true };
    }
    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

// ---- triggerWorkflowRun Action ----
app.post('/triggerWorkflowRun', async (req, res) => {
  try {
    const sessionVars = req.body.session_variables || {};
    const userId = sessionVars['x-hasura-user-id'];
    const workflowId = req.body.input.workflow_id;

    if (!userId) return res.status(401).json({ message: 'Not authenticated' });

    // 1. Verify caller is owner/editor in workflow's org + get org_id
    const wfData = await gql(`
      query($id: uuid!) {
        workflows_by_pk(id: $id) {
          id
          org_id
          organization {
            quota_calls_used
            quota_calls_allowed
            org_members(where: {user_id: {_eq: "${userId}"}}) {
              role
            }
          }
        }
      }
    `, { id: workflowId });

    const workflow = wfData.workflows_by_pk;
    if (!workflow) return res.status(404).json({ message: 'Workflow not found' });

    const member = workflow.organization.org_members[0];
    if (!member || !['owner', 'editor'].includes(member.role)) {
      return res.status(403).json({ message: 'Not authorized to trigger this workflow' });
    }

    // 2. Check quota
    const { quota_calls_used, quota_calls_allowed } = workflow.organization;
    if (quota_calls_used >= quota_calls_allowed) {
      return res.status(429).json({ message: 'Quota exhausted' });
    }

    // 3. Create workflow_run
    const runData = await gql(`
      mutation($workflow_id: uuid!, $started_by: uuid!, $triggered_via: String!) {
        insert_workflow_runs_one(object: {
          workflow_id: $workflow_id,
          status: "running",
          started_by: $started_by,
          triggered_via: $triggered_via
        }) { id }
      }
    `, { workflow_id: workflowId, started_by: userId, triggered_via: req.body.input.triggered_via || 'manual' });

    const runId = runData.insert_workflow_runs_one.id;

    // Respond immediately, then execute steps async
    res.json({ run_id: runId, status: 'running' });

    // 4. Get ordered steps
    const stepsData = await gql(`
      query($workflow_id: uuid!) {
        workflow_steps(where: {workflow_id: {_eq: $workflow_id}}, order_by: {step_order: asc}) {
          id
          type
          config
          step_order
        }
      }
    `, { workflow_id: workflowId });

    let previousOutput = null;

    for (const step of stepsData.workflow_steps) {
      // create step_run as running
      const stepRunData = await gql(`
        mutation($workflow_run_id: uuid!, $step_id: uuid!) {
          insert_step_runs_one(object: {
            workflow_run_id: $workflow_run_id,
            step_id: $step_id,
            status: "running",
            attempt_count: 1
          }) { id }
        }
      `, { workflow_run_id: runId, step_id: step.id });

      const stepRunId = stepRunData.insert_step_runs_one.id;

      if (step.type === 'approval_gate') {
        await gql(`
          mutation($id: uuid!) {
            update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: "paused"}) { id }
          }
        `, { id: stepRunId });
        await gql(`
          mutation($id: uuid!) {
            update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: "paused"}) { id }
          }
        `, { id: runId });
        console.log(`Run ${runId} paused at approval_gate step ${step.id}`);
        return; // stop execution here
      }

      try {
        const result = await executeStep(step, previousOutput);
        previousOutput = result.output;
        await gql(`
          mutation($id: uuid!, $output: jsonb!) {
            update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: "success", output: $output}) { id }
          }
        `, { id: stepRunId, output: result.output });
      } catch (err) {
        await gql(`
          mutation($id: uuid!, $error: String!) {
            update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: "failed", error: $error}) { id }
          }
        `, { id: stepRunId, error: err.message });
        await gql(`
          mutation($id: uuid!) {
            update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: "failed", finished_at: "now()"}) { id }
          }
        `, { id: runId });
        return;
      }
    }

    // All steps completed successfully
    await gql(`
      mutation($id: uuid!) {
        update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: "completed", finished_at: "now()"}) { id }
      }
    `, { id: runId });

    await gql(`
      mutation($org_id: uuid!) {
        update_organizations_by_pk(pk_columns: {id: $org_id}, _inc: {quota_calls_used: 1}) { id }
      }
    `, { org_id: workflow.org_id });

  } catch (err) {
    console.error('triggerWorkflowRun error:', err);
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
});

// ---- approveStep Action ----
app.post('/approveStep', async (req, res) => {
  try {
    const sessionVars = req.body.session_variables || {};
    const userId = sessionVars['x-hasura-user-id'];
    const stepRunId = req.body.input.step_run_id;

    if (!userId) return res.status(401).json({ message: 'Not authenticated' });

    // Get step_run -> workflow_run -> workflow -> org -> caller's role
    const data = await gql(`
      query($id: uuid!, $user_id: uuid!) {
        step_runs_by_pk(id: $id) {
          id
          status
          workflow_run_id
          workflow_run {
            workflow_id
            workflow {
              org_id
              organization {
                org_members(where: {user_id: {_eq: $user_id}}) {
                  role
                }
              }
            }
          }
        }
      }
    `, { id: stepRunId, user_id: userId });

    const stepRun = data.step_runs_by_pk;
    if (!stepRun) return res.status(404).json({ message: 'Step run not found' });
    if (stepRun.status !== 'paused') return res.status(400).json({ message: 'Step is not paused' });

    const member = stepRun.workflow_run.workflow.organization.org_members[0];
    if (!member || !['owner', 'editor'].includes(member.role)) {
      return res.status(403).json({ message: 'Not authorized to approve this step' });
    }

    // Mark step approved
    await gql(`
      mutation($id: uuid!, $approved_by: uuid!) {
        update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: "success", approved_by: $approved_by, approved_at: "now()"}) { id }
      }
    `, { id: stepRunId, approved_by: userId });

    const runId = stepRun.workflow_run_id;
    const workflowId = stepRun.workflow_run.workflow_id;

    await gql(`
      mutation($id: uuid!) {
        update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: "running"}) { id }
      }
    `, { id: runId });

    res.json({ status: 'resumed' });

    // Resume remaining steps after this one
    const allSteps = await gql(`
      query($workflow_id: uuid!) {
        workflow_steps(where: {workflow_id: {_eq: $workflow_id}}, order_by: {step_order: asc}) {
          id
          type
          config
          step_order
        }
      }
    `, { workflow_id: workflowId });

    const approvedStepData = await gql(`
      query($id: uuid!) { step_runs_by_pk(id: $id) { step_id } }
    `, { id: stepRunId });

    const approvedStepId = approvedStepData.step_runs_by_pk.step_id;
    const approvedIndex = allSteps.workflow_steps.findIndex(s => s.id === approvedStepId);
    const remainingSteps = allSteps.workflow_steps.slice(approvedIndex + 1);

    let previousOutput = { approved: true };

    for (const step of remainingSteps) {
      const stepRunData = await gql(`
        mutation($workflow_run_id: uuid!, $step_id: uuid!) {
          insert_step_runs_one(object: {
            workflow_run_id: $workflow_run_id,
            step_id: $step_id,
            status: "running",
            attempt_count: 1
          }) { id }
        }
      `, { workflow_run_id: runId, step_id: step.id });

      const newStepRunId = stepRunData.insert_step_runs_one.id;

      if (step.type === 'approval_gate') {
        await gql(`
          mutation($id: uuid!) {
            update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: "paused"}) { id }
          }
        `, { id: newStepRunId });
        await gql(`
          mutation($id: uuid!) {
            update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: "paused"}) { id }
          }
        `, { id: runId });
        return;
      }

      try {
        const result = await executeStep(step, previousOutput);
        previousOutput = result.output;
        await gql(`
          mutation($id: uuid!, $output: jsonb!) {
            update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: "success", output: $output}) { id }
          }
        `, { id: newStepRunId, output: result.output });
      } catch (err) {
        await gql(`
          mutation($id: uuid!, $error: String!) {
            update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: "failed", error: $error}) { id }
          }
        `, { id: newStepRunId, error: err.message });
        await gql(`
          mutation($id: uuid!) {
            update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: "failed", finished_at: "now()"}) { id }
          }
        `, { id: runId });
        return;
      }
    }

    await gql(`
      mutation($id: uuid!) {
        update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: "completed", finished_at: "now()"}) { id }
      }
    `, { id: runId });

  } catch (err) {
    console.error('approveStep error:', err);
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
});


// ---- Webhook Trigger Endpoint ----
app.post('/webhookTrigger/:workflow_id', async (req, res) => {
  try {
    const workflowId = req.params.workflow_id;
    const providedSecret = req.headers['x-webhook-secret'];
    if (!providedSecret) return res.status(401).json({ message: 'Missing X-Webhook-Secret header' });

    const data = await gql(`
      query($workflow_id: uuid!) {
        workflow_triggers(where: {workflow_id: {_eq: $workflow_id}, type: {_eq: "webhook"}}) { id config }
      }
    `, { workflow_id: workflowId });

    const trigger = data.workflow_triggers[0];
    if (!trigger) return res.status(404).json({ message: 'No webhook trigger configured for this workflow' });

    const expectedSecret = trigger.config && trigger.config.secret;
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return res.status(403).json({ message: 'Invalid webhook secret' });
    }

    const ownerData = await gql(`
      query($workflow_id: uuid!) {
        workflows_by_pk(id: $workflow_id) {
          organization { org_members(where: {role: {_in: ["owner", "editor"]}}, limit: 1) { user_id } }
        }
      }
    `, { workflow_id: workflowId });

    const workflow = ownerData.workflows_by_pk;
    if (!workflow) return res.status(404).json({ message: 'Workflow not found' });
    const member = workflow.organization.org_members[0];
    if (!member) return res.status(400).json({ message: 'No eligible member to attribute this run to' });

    const port = process.env.PORT || 4000;
    const triggerRes = await globalThis.fetch(`http://localhost:${port}/triggerWorkflowRun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_variables: { 'x-hasura-user-id': member.user_id },
        input: { workflow_id: workflowId, triggered_via: 'webhook' },
      }),
    });
    const result = await triggerRes.json();
    res.status(triggerRes.status).json(result);
  } catch (err) {
    console.error('webhookTrigger error:', err);
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
});
app.listen(process.env.PORT || 4000, () => {
  console.log(`Server running on port ${process.env.PORT || 4000}`);
});
