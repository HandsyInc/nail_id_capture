import { NextResponse } from "next/server";
import { uploadToR2 } from "@/lib/r2";

export const dynamic = "force-dynamic";

export async function GET() {
  const key = `dev-test/${Date.now()}-hello.txt`;

  const result = await uploadToR2({
    key,
    body: "Hello from Handsy R2 test",
    contentType: "text/plain",
  });

  return NextResponse.json({
    ok: true,
    result,
  });
}