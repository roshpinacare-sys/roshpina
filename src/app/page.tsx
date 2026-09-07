"use client";

/**
 * page.tsx — קונסולת רושפינה · RTL.
 * ראש עם צ'יפ-בריאות חי · שורת-מדדים · טאבים לשבעת-המסכים · פוטר דביק.
 * כל-מסך מצבע את-מקורו בעצמו (use-polling) ומגיב עד-390px.
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConsoleHeader } from "@/components/roshpina/header";
import { KpiRow } from "@/components/roshpina/kpi-row";
import { ConsoleFooter } from "@/components/roshpina/footer";
import { LedgerPanel } from "@/components/roshpina/ledger-panel";
import { EscrowPanel } from "@/components/roshpina/escrow-panel";
import { MarketplacePanel } from "@/components/roshpina/marketplace-panel";
import { PassportsPanel } from "@/components/roshpina/passports-panel";
import { AuditPanel } from "@/components/roshpina/audit-panel";
import { PotentialPanel } from "@/components/roshpina/potential-panel";
import { BridgePanel } from "@/components/roshpina/bridge-panel";
import { cn } from "@/lib/utils";

const TAB_TRIGGER = "rounded-md px-3 py-2 text-xs md:text-sm data-[state=active]:bg-gold/15 data-[state=active]:text-gold data-[state=active]:shadow-none";

export default function Page() {
  return (
    <div className="flex min-h-screen flex-col">
      <ConsoleHeader />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:py-8">
        <KpiRow />

        <Tabs defaultValue="ledger" className="mt-6 md:mt-8">
          <div className="overflow-x-auto pb-1">
            <TabsList className="inline-flex h-auto w-max min-w-full gap-1 bg-muted/60 p-1">
              <TabsTrigger value="ledger" className={cn(TAB_TRIGGER)}>הספר</TabsTrigger>
              <TabsTrigger value="escrow" className={cn(TAB_TRIGGER)}>ההצבה</TabsTrigger>
              <TabsTrigger value="market" className={cn(TAB_TRIGGER)}>השוק</TabsTrigger>
              <TabsTrigger value="passports" className={cn(TAB_TRIGGER)}>הדרכונים</TabsTrigger>
              <TabsTrigger value="audit" className={cn(TAB_TRIGGER)}>הביקורת</TabsTrigger>
              <TabsTrigger value="potential" className={cn(TAB_TRIGGER)}>הפוטנציאל</TabsTrigger>
              <TabsTrigger value="bridge" className={cn(TAB_TRIGGER)}>הגשר</TabsTrigger>
            </TabsList>
          </div>

          <div className="mt-4">
            <TabsContent value="ledger"><LedgerPanel /></TabsContent>
            <TabsContent value="escrow"><EscrowPanel /></TabsContent>
            <TabsContent value="market"><MarketplacePanel /></TabsContent>
            <TabsContent value="passports"><PassportsPanel /></TabsContent>
            <TabsContent value="audit"><AuditPanel /></TabsContent>
            <TabsContent value="potential"><PotentialPanel /></TabsContent>
            <TabsContent value="bridge"><BridgePanel /></TabsContent>
          </div>
        </Tabs>
      </main>

      <ConsoleFooter />
    </div>
  );
}
