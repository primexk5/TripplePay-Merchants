import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Logo } from "@/components/logo";

export const metadata = {
  title: "Terms of Service - TripplePay || Merchants",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-[#171717] px-5 py-12 text-[#c9d4e0] sm:py-20">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/"
          className="group mb-8 inline-flex items-center gap-2 text-sm text-[#8b93a7] transition hover:text-white"
        >
          <ArrowLeft size={16} className="transition-transform group-hover:-translate-x-1" />
          Back to home
        </Link>
        
        <div className="mb-12 flex items-center gap-3">
          <Logo className="h-8 w-8" />
          <h1 className="text-2xl font-semibold text-white sm:text-3xl">
            Terms of Service
          </h1>
        </div>

        <div className="prose prose-invert max-w-none prose-h2:mt-10 prose-h2:mb-4 prose-h2:text-xl prose-h2:font-medium prose-h2:text-white prose-p:mb-4 prose-p:leading-relaxed prose-li:my-2 prose-a:text-[#38bdf8] hover:prose-a:text-[#67d8ff]">
          <p>
            Last Updated: {new Date().toLocaleDateString("en-US", { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
          
          <p>
            Welcome to TripplePay || Merchants. These Terms of Service (&quot;Terms&quot;) govern your use of the TripplePay || Merchants application, website, and related services (collectively, the &quot;Service&quot;). By using the Service, you agree to these Terms. If you do not agree to these Terms, do not use the Service.
          </p>

          <h2>1. Description of Service</h2>
          <p>
            TripplePay || Merchants is a decentralized, non-custodial payment gateway interface built on the Quai Network. It allows merchants to generate payment links and directly receive cryptocurrency payments from customers. 
          </p>
          <p>
            The Service operates solely as an interface. We do not host wallets, manage private keys, process transactions centrally, or hold any user funds. All transactions are peer-to-peer and executed directly on the Quai Network blockchain.
          </p>

          <h2>2. Non-Custodial Nature</h2>
          <p>
            You acknowledge and agree that TripplePay || Merchants is entirely non-custodial. You maintain full control over your cryptocurrency at all times. TripplePay || Merchants does not take possession, custody, or control over any digital assets, nor do we act as an intermediary, custodian, or exchange.
          </p>
          <p>
            You are solely responsible for securely storing your private keys and seed phrases. If you lose access to your wallet, TripplePay || Merchants cannot recover your funds.
          </p>

          <h2>3. User Responsibilities</h2>
          <ul className="list-disc pl-5">
            <li>You must ensure that your use of the Service complies with all applicable local, state, national, and international laws and regulations.</li>
            <li>You are responsible for verifying the accuracy of transaction details, including recipient addresses and payment amounts, before signing or confirming any transaction.</li>
            <li>You agree not to use the Service for any illegal, fraudulent, or malicious activities.</li>
          </ul>

          <h2>4. Blockchain Risks</h2>
          <p>
            Transactions on the Quai Network (and other blockchains) are generally irreversible. You understand the risks associated with cryptocurrency transactions, including but not limited to network congestion, fluctuating gas prices, smart contract vulnerabilities, and the risk of loss due to user error (e.g., sending funds to the wrong address).
          </p>

          <h2>5. Limitation of Liability</h2>
          <p>
            To the maximum extent permitted by law, TripplePay || Merchants and its developers, contributors, and affiliates shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits or revenues, whether incurred directly or indirectly, or any loss of data, use, goodwill, or other intangible losses, resulting from:
          </p>
          <ul className="list-disc pl-5">
            <li>Your access to or use of or inability to access or use the Service.</li>
            <li>Any conduct or content of any third party on the Service.</li>
            <li>Any errors or omissions in the Service.</li>
            <li>Loss of funds, private keys, or digital assets.</li>
          </ul>

          <h2>6. No Warranties</h2>
          <p>
            The Service is provided &quot;AS IS&quot; and &quot;AS AVAILABLE&quot; without warranties of any kind, whether express or implied. We do not guarantee that the Service will be uninterrupted, error-free, secure, or available at any particular time or location.
          </p>

          <h2>7. Changes to Terms</h2>
          <p>
            We may modify these Terms at any time. If we make material changes, we will attempt to provide reasonable notice. Your continued use of the Service after any changes constitutes acceptance of the new Terms.
          </p>

          <h2>8. Contact</h2>
          <p>
            If you have any questions about these Terms, please contact the TripplePay || Merchants team through the official repository or community channels.
          </p>
        </div>
        
        <footer className="mt-16 border-t border-white/7 pt-8 text-center text-xs text-[#4f5868]">
          &copy; {new Date().getFullYear()} TripplePay || Merchants. All rights reserved.
        </footer>
      </div>
    </main>
  );
}
