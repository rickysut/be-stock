import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/pool";

// GET /api/orders - list all orders
export async function GET() {
    const client = await pool.connect();
    try {
        const ordersRes = await client.query('SELECT * FROM sales_order ORDER BY order_no');

        if (ordersRes.rowCount && ordersRes.rowCount > 0) {
            const orderNos = ordersRes.rows.map((o: any) => o.order_no);
            const detailsRes = await client.query(
                'SELECT * FROM sales_order_details WHERE sales_order = ANY($1)',
                [orderNos]
            );

            const detailsMap: Record<string, any[]> = {};
            for (const d of detailsRes.rows) {
                const key: string = d.sales_order;
                if (!detailsMap[key]) detailsMap[key] = [];
                detailsMap[key].push(d);
            }

            const data = ordersRes.rows.map((o: any) => ({
                ...o,
                details: detailsMap[o.order_no] ?? [],
            }));

            return NextResponse.json({ data }, { status: 200 });
        }

        return NextResponse.json({ data: [] }, { status: 200 });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: 'Database error', details: message }, { status: 500 });
    } finally {
        client.release();
    }
}

// POST /api/orders
export async function POST(req: NextRequest) {
    const body = await req.json();
    const order_no = body?.order_no as string | undefined;
    const cust_id = body?.cust_id as string | undefined;
    const items = body?.items as Array<{ item_id: number; qty: number; price?: number; } | any> | undefined;

    if (!order_no || typeof order_no !== 'string') {
        return NextResponse.json({ error: 'order_no is required' }, { status: 400 });
    }
    if (!cust_id || typeof cust_id !== 'string') {
        return NextResponse.json({ error: 'cust_id is required' }, { status: 400 });
    }
    if (!Array.isArray(items) || items.length === 0) {
        return NextResponse.json({ error: 'items is required' }, { status: 400 });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const existing = await client.query('SELECT * FROM sales_order WHERE order_no = $1 LIMIT 1', [order_no]);
        if (existing.rowCount && existing.rowCount > 0) {
            await client.query('ROLLBACK');
            return NextResponse.json({ error: 'Sales Order already exists' }, { status: 409 });
        }

        // Validate stock and gather pricing
        let grand_total = 0;

        const preparedItems: Array<{ item_id: number; item_name: string; qty: number; price: number; total: number }> = [];

        for (const it of items) {
            const qty = typeof it.qty === 'number' ? it.qty : Number(it.qty);

            const itemRes = await client.query('SELECT id, name, price FROM items WHERE id = $1 LIMIT 1', [it.item_id]);
            if (!itemRes.rowCount) {
                await client.query('ROLLBACK');
                return NextResponse.json({ error: `Item ${it.item_id} not found` }, { status: 404 });
            }

            const stockRes = await client.query('SELECT COALESCE(SUM(qty_in), 0) as totin, COALESCE(SUM(qty_out), 0) as totout FROM stocks WHERE item_id = $1', [it.item_id]);
            if (!stockRes.rowCount) {
                await client.query('ROLLBACK');
                return NextResponse.json({ error: `Item ${it.item_id} is empty` }, { status: 404 });
            }
            const dbStock = stockRes.rows[0] as { totin: number | 0; totout: number | 0 };

            const stockNum = dbStock.totin - dbStock.totout;
            if (stockNum < qty || stockNum <= 0) {
                await client.query('ROLLBACK');
                return NextResponse.json({ error: `Stock habis / tidak cukup untuk item ${it.item_id}`, stock: stockNum, requested: qty }, { status: 409 });
            }

            const dbItem = itemRes.rows[0] as { id: number; name: string; price: number | 0 };
            const itemName = dbItem.name;
            const priceNum = dbItem.price == null ? 0 : dbItem.price;
            const lineTotal = Math.max(0, priceNum * qty);
            grand_total += lineTotal
            preparedItems.push({ item_id: it.item_id, item_name: itemName, qty, price: priceNum, total: lineTotal });
        }

        // Sales Order
        await client.query(
            'INSERT INTO sales_order (order_no, cust_id, grand_total, updated_at) VALUES ($1, $2, $3, $4)',
            [order_no, cust_id, grand_total, new Date()]
        );

        // Insert details 
        for (const pit of preparedItems) {
            await client.query(
                'INSERT INTO sales_order_details (sales_order, item_id, item_name, item_qty, item_price, row_total, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [order_no, pit.item_id, pit.item_name, pit.qty, pit.price, pit.total, new Date()]
            );
            await client.query('INSERT INTO stocks (item_id, qty_in, qty_out, updated_at) VALUES ($1, $2, $3, $4)', [pit.item_id, 0, pit.qty, new Date()]);
        }

        await client.query('COMMIT');

        return NextResponse.json(
            {
                order_no,
                cust_id,
                grand_total,
                items: preparedItems,
            },
            { status: 201 }
        );
    } catch (err) {
        await client.query('ROLLBACK');
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: 'Database error', details: message }, { status: 500 });
    } finally {
        client.release();
    }
}
