"use client";

import type { BookingConfirmation } from "@/lib/types";

/** The booking receipt: date/time, name, email, and the confirmation code. */
export function ConfirmationCard({ booking }: { booking: BookingConfirmation }) {
  return (
    <div className="card" role="status">
      <h3>✓ Demo booked</h3>
      <dl>
        <dt>When</dt>
        <dd>{booking.label}</dd>
        <dt>Name</dt>
        <dd>{booking.name}</dd>
        <dt>Email</dt>
        <dd>{booking.email}</dd>
        <dt>Confirmation</dt>
        <dd className="code">{booking.code}</dd>
      </dl>
    </div>
  );
}
