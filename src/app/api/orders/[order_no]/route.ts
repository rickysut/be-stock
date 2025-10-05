import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/pool";

// GET /api/orders/[order_no]
export async function GET(
  _req: NextRequest,
  context: { params: { order_no?: string } }
) {
  const order_no = context.params.order_no;

  if (!order_no || typeof order_no !== "string") {
    return NextResponse.json({ error: "order_no is required" }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM sales_order WHERE order_no = $1 LIMIT 1",
      [order_no]
    );

    if (result.rowCount && result.rowCount > 0) {
      const detailsRes = await client.query(
        "SELECT * FROM sales_order_details WHERE sales_order = $1",
        [order_no]
      );

      const order = result.rows[0];
      const details = detailsRes.rows ?? [];

      // Preserve array shape in `data` while including details
      return NextResponse.json(
        { data: [{ ...order, details }] },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { data: [], error: "Sales Order not found" },
      { status: 404 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Database error", details: message },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
