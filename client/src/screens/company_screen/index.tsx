import { DisplayError, DisplayLoading, DisplayPageHeader } from "components/display_components";
import { useCompanyData } from "utils/hooks/useAgentGuardQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { formatDate, formatDateTime, formatMoney } from "utils/helper_functions/format";

// The company's own records. Watch them change when an agent acts, and change back on Undo.
export const CompanyScreen = () => {
  const { data, isLoading, error, refetch } = useCompanyData();

  return (
    <>
      <DisplayPageHeader
        title="Company data"
        description="The demo company's real records. Agents can only change them through AgentGuard, so every change here has an entry in Activity."
      />
      {isLoading && <DisplayLoading label="Loading company data" />}
      {error && <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />}

      {data && (
        <div className="flex flex-col gap-10">
          <section>
            <h2 className="mb-3 text-lg font-semibold">Bookings</h2>
            <div className="overflow-x-auto rounded-lg border border-line bg-sheet">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-line text-ink-soft">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">Booking</th>
                    <th scope="col" className="px-4 py-3 font-medium">Customer</th>
                    <th scope="col" className="px-4 py-3 font-medium">Starts</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Price</th>
                    <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.bookings.map((booking) => (
                    <tr key={booking.code}>
                      <td className="px-4 py-3">
                        <span className="font-medium">{booking.code}</span>
                        <span className="block text-ink-soft">{booking.title}</span>
                      </td>
                      <td className="px-4 py-3">
                        {booking.customerName}
                        <span className="block text-ink-faint">{booking.customerCode}</span>
                      </td>
                      <td className="px-4 py-3">{formatDate(booking.startsAt)}</td>
                      <td className="px-4 py-3 text-right">
                        {formatMoney(booking.amount)}
                        {booking.discountPercent > 0 && <span className="block text-xs text-done">{booking.discountPercent}% off</span>}
                      </td>
                      <td className="px-4 py-3">
                        {booking.status === "cancelled" ? (
                          <span className="text-refused">
                            Cancelled
                            <span className="block text-xs text-ink-faint">Refund {formatMoney(booking.refundAmount)}</span>
                          </span>
                        ) : (
                          <span className="text-done">Confirmed</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="grid gap-8 lg:grid-cols-2">
            <div>
              <h2 className="mb-3 text-lg font-semibold">Customers</h2>
              <ul className="divide-y divide-line rounded-lg border border-line bg-sheet text-sm">
                {data.customers.map((customer) => (
                  <li key={customer.code} className="flex justify-between gap-3 px-4 py-2.5">
                    <span>
                      {customer.name} <span className="text-ink-faint">{customer.code}</span>
                    </span>
                    <span className="truncate text-ink-soft">{customer.email}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="mb-3 text-lg font-semibold">Emails sent</h2>
              {data.outbox.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line bg-sheet px-4 py-6 text-sm text-ink-soft">No emails have been sent yet.</p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line bg-sheet text-sm">
                  {data.outbox.map((message) => (
                    <li key={message.id} className="px-4 py-2.5">
                      <p>{message.subject}</p>
                      <p className="text-ink-faint">
                        To {message.customerName}, {formatDateTime(message.sentAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
};
