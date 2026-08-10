import { gql } from '@apollo/client';

export const GET_ORG_WORKFLOWS = gql`
  query GetOrgWorkflows($org_id: uuid!) {
    organizations_by_pk(id: $org_id) {
      id
      name
      quota_calls_used
      quota_calls_allowed
      quota_period_start
    }
    workflows(where: { org_id: { _eq: $org_id } }, order_by: { created_at: desc }) {
      id
      name
      created_at
      workflow_steps(order_by: { step_order: asc }) {
        id
        type
        step_order
      }
      workflow_triggers {
        id
        type
      }
      workflow_runs(order_by: { started_at: desc }, limit: 1) {
        id
        status
        started_at
      }
    }
  }
`;

export const TRIGGER_WORKFLOW_RUN = gql`
  mutation TriggerWorkflowRun($workflow_id: uuid!) {
    triggerWorkflowRun(workflow_id: $workflow_id) {
      run_id
      status
    }
  }
`;
