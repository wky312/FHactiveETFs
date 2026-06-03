import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const OWNER    = 'wky312';
const REPO     = '00998a-web';
const WORKFLOW = 'daily_summary.yml';
const REF      = 'master';

export async function POST(request: NextRequest) {
  // Validate secret
  const auth   = request.headers.get('authorization') ?? '';
  const secret = process.env.CRON_TRIGGER_SECRET ?? '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = process.env.GITHUB_WORKFLOW_TOKEN ?? '';
  if (!token) {
    return NextResponse.json({ error: 'GITHUB_WORKFLOW_TOKEN not set' }, { status: 500 });
  }

  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method:  'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:        'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: REF }),
    }
  );

  if (res.status === 204) {
    return NextResponse.json({ ok: true, triggered: new Date().toISOString() });
  }
  const body = await res.text();
  return NextResponse.json({ error: body }, { status: res.status });
}
