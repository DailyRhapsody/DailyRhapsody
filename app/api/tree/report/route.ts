import { NextResponse } from "next/server";
import report from "@/public/tree/report.json";

export const revalidate = 3600;

export async function GET() {
  return NextResponse.json(report, {
    headers: {
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
